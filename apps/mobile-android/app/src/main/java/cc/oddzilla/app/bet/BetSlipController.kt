package cc.oddzilla.app.bet

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import cc.oddzilla.app.common.decimalToMicro
import cc.oddzilla.app.data.api.PlaceBetSelection
import cc.oddzilla.app.data.api.TicketSummary
import cc.oddzilla.app.data.repo.BetsRepository
import cc.oddzilla.app.data.ws.LiveOddsClient
import cc.oddzilla.app.data.ws.OddsKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.math.BigDecimal
import java.math.RoundingMode

// Cross-match bet slip. Mirrors the web BetSlipProvider: cross-match
// selections (max 20), Single vs Combo toggle, USDC vs OZ currency
// switcher (persisted via DataStore — mobile picks up where it left
// off across launches). Place-bet flow lives here so the bottom sheet
// stays UI-only.
//
// Drift handling: the controller subscribes to the LiveOdds StateFlow
// and watches every selection's `(matchId, marketId, outcomeId)` tuple.
// When the broker tick differs from the user's accepted `odds`, the
// leg's `pendingOdds` is set; the sheet renders an "X.XX → Y.YY"
// delta and disables the place button. The user explicitly accepts
// the new prices via acceptPendingOdds(), which copies pending → odds
// for every leg with a pending change. Clearing the pending happens
// automatically when a subsequent tick matches the user's accepted
// price (broker bounced and came back).

private val Context.slipStore by preferencesDataStore(name = "oddzilla_slip")
private val CURRENCY_KEY = stringPreferencesKey("currency")
private val MODE_KEY = stringPreferencesKey("mode")

enum class SlipMode { Single, Combo }

data class SlipSelection(
    val matchId: String,
    val marketId: String,
    val outcomeId: String,
    val odds: String,
    val homeTeam: String,
    val awayTeam: String,
    val marketLabel: String,
    val outcomeLabel: String,
    val sportSlug: String,
    val active: Boolean = true,
    /**
     * Latest broker odds when they differ from the user-accepted `odds`
     * above. Set by the WS-watcher coroutine; cleared whenever a tick
     * lands matching `odds` again or the user explicitly accepts the
     * change (acceptPendingOdds copies pending → odds).
     */
    val pendingOdds: String? = null,
)

data class SlipState(
    val selections: List<SlipSelection> = emptyList(),
    val mode: SlipMode = SlipMode.Single,
    val currency: String = "OZ",
    val stakeText: String = "10",
    val placing: Boolean = false,
    val lastError: String? = null,
)

class BetSlipController(
    private val context: Context,
    private val betsRepo: BetsRepository,
    private val liveOdds: LiveOddsClient,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _state = MutableStateFlow(SlipState())
    val state: StateFlow<SlipState> = _state.asStateFlow()

    init {
        runBlocking {
            val prefs = context.slipStore.data.first()
            val currency = prefs[CURRENCY_KEY] ?: "OZ"
            val mode = prefs[MODE_KEY]?.let { runCatching { SlipMode.valueOf(it) }.getOrNull() } ?: SlipMode.Single
            _state.value = _state.value.copy(currency = currency, mode = mode)
        }
        // Watch every odds tick; reconcile pending against the current
        // selection set whenever either side changes.
        scope.launch {
            liveOdds.odds.collect { reconcilePending(it) }
        }
    }

    /** Returns true if any leg currently has a pendingOdds set. */
    fun hasPending(): Boolean = _state.value.selections.any { it.pendingOdds != null }

    fun add(selection: SlipSelection) {
        val cur = _state.value
        val filtered = cur.selections.filter {
            !(it.matchId == selection.matchId && it.marketId == selection.marketId)
        }
        val sameAsExisting = cur.selections.any {
            it.matchId == selection.matchId &&
                it.marketId == selection.marketId &&
                it.outcomeId == selection.outcomeId
        }
        val next = if (sameAsExisting) filtered else (filtered + selection).take(20)
        _state.value = cur.copy(selections = next, lastError = null)
        syncSubscriptions(prev = cur.selections, now = next)
    }

    fun remove(matchId: String, marketId: String, outcomeId: String) {
        val prev = _state.value.selections
        val next = prev.filterNot {
            it.matchId == matchId && it.marketId == marketId && it.outcomeId == outcomeId
        }
        _state.value = _state.value.copy(selections = next, lastError = null)
        syncSubscriptions(prev = prev, now = next)
    }

    fun clear() {
        val prev = _state.value.selections
        _state.value = _state.value.copy(selections = emptyList(), lastError = null)
        syncSubscriptions(prev = prev, now = emptyList())
    }

    fun setMode(mode: SlipMode) {
        _state.value = _state.value.copy(mode = mode)
        scope.launch { context.slipStore.edit { it[MODE_KEY] = mode.name } }
    }

    fun setCurrency(currency: String) {
        _state.value = _state.value.copy(currency = currency)
        scope.launch { context.slipStore.edit { it[CURRENCY_KEY] = currency } }
    }

    fun setStakeText(text: String) {
        _state.value = _state.value.copy(stakeText = text.filter { it.isDigit() || it == '.' }, lastError = null)
    }

    fun isSelected(matchId: String, marketId: String, outcomeId: String): Boolean =
        _state.value.selections.any {
            it.matchId == matchId && it.marketId == marketId && it.outcomeId == outcomeId
        }

    /**
     * Copies `pendingOdds` → `odds` on every leg that has a pending
     * change. Called when the user taps "Accept odds change" in the
     * sheet — it's the explicit consent step before placement.
     */
    fun acceptPendingOdds() {
        _state.value = _state.value.copy(
            selections = _state.value.selections.map {
                if (it.pendingOdds != null) it.copy(odds = it.pendingOdds, pendingOdds = null) else it
            },
            lastError = null,
        )
    }

    fun comboOdds(): BigDecimal? {
        val s = _state.value
        if (s.mode != SlipMode.Combo || s.selections.isEmpty()) return null
        return s.selections.fold(BigDecimal.ONE) { acc, leg ->
            acc.multiply(leg.odds.toBigDecimalOrNull() ?: BigDecimal.ONE)
        }.setScale(2, RoundingMode.DOWN)
    }

    fun potentialPayoutMicro(): String? {
        val s = _state.value
        val stake = s.stakeText.toBigDecimalOrNull() ?: return null
        if (stake <= BigDecimal.ZERO || s.selections.isEmpty()) return null
        val unit = BigDecimal(1_000_000)
        val payoutDecimal: BigDecimal = when (s.mode) {
            SlipMode.Single -> s.selections.sumOf { leg ->
                stake.multiply(leg.odds.toBigDecimalOrNull() ?: BigDecimal.ONE)
            }
            SlipMode.Combo -> stake.multiply(comboOdds() ?: BigDecimal.ONE)
        }
        return payoutDecimal.multiply(unit).setScale(0, RoundingMode.DOWN).toPlainString()
    }

    suspend fun place(): List<TicketSummary>? {
        val s = _state.value
        if (s.placing) return null
        if (hasPending()) {
            _state.value = s.copy(lastError = "Odds changed — accept the new price before placing.")
            return null
        }
        val stakeDecimal = s.stakeText.toBigDecimalOrNull()
        if (stakeDecimal == null || stakeDecimal <= BigDecimal.ZERO) {
            _state.value = s.copy(lastError = "Enter a stake first.")
            return null
        }
        if (s.selections.isEmpty()) {
            _state.value = s.copy(lastError = "Pick at least one outcome.")
            return null
        }
        val stakeMicro = decimalToMicro(stakeDecimal)
        _state.value = s.copy(placing = true, lastError = null)
        val placed = mutableListOf<TicketSummary>()
        try {
            when (s.mode) {
                SlipMode.Combo -> {
                    if (s.selections.size < 2) {
                        placed += placeSingle(s.selections[0], stakeMicro, s.currency)
                    } else {
                        placed += betsRepo.place(
                            currency = s.currency,
                            stakeMicro = stakeMicro,
                            betType = "combo",
                            selections = s.selections.map {
                                PlaceBetSelection(it.marketId, it.outcomeId, it.odds)
                            },
                        )
                    }
                }
                SlipMode.Single -> {
                    for (leg in s.selections) {
                        placed += placeSingle(leg, stakeMicro, s.currency)
                    }
                }
            }
            val prev = _state.value.selections
            _state.value = _state.value.copy(
                placing = false,
                selections = emptyList(),
                lastError = null,
            )
            syncSubscriptions(prev = prev, now = emptyList())
            return placed
        } catch (e: Throwable) {
            _state.value = _state.value.copy(
                placing = false,
                lastError = e.message?.takeIf { it.isNotBlank() } ?: "Could not place bet.",
            )
            return null
        }
    }

    private suspend fun placeSingle(leg: SlipSelection, stakeMicro: String, currency: String): TicketSummary =
        betsRepo.place(
            currency = currency,
            stakeMicro = stakeMicro,
            betType = "single",
            selections = listOf(PlaceBetSelection(leg.marketId, leg.outcomeId, leg.odds)),
        )

    private fun reconcilePending(odds: Map<OddsKey, cc.oddzilla.app.data.ws.OddsTick>) {
        val cur = _state.value
        if (cur.selections.isEmpty()) return
        var changed = false
        val next = cur.selections.map { leg ->
            val tick = odds[OddsKey(leg.matchId, leg.marketId, leg.outcomeId)]
            if (tick == null) return@map leg
            val tickOdds = tick.odds
            val matches = oddsEqual(tickOdds, leg.odds)
            when {
                matches && leg.pendingOdds != null -> {
                    changed = true
                    leg.copy(pendingOdds = null)
                }
                !matches && leg.pendingOdds != tickOdds -> {
                    changed = true
                    leg.copy(pendingOdds = tickOdds)
                }
                else -> leg
            }
        }
        if (changed) _state.value = cur.copy(selections = next)
    }

    /**
     * Diff the previous and current selection sets and tell LiveOdds
     * about it. Subscriptions are refcounted at the WS client level so
     * a re-sub on the same match is cheap (refcount only).
     */
    private fun syncSubscriptions(prev: List<SlipSelection>, now: List<SlipSelection>) {
        val prevIds = prev.map { it.matchId }.toSet()
        val nowIds = now.map { it.matchId }.toSet()
        val toAdd = nowIds - prevIds
        val toRemove = prevIds - nowIds
        if (toAdd.isNotEmpty()) liveOdds.subscribe(toAdd)
        if (toRemove.isNotEmpty()) liveOdds.unsubscribe(toRemove)
    }

    private fun oddsEqual(a: String, b: String): Boolean {
        val da = a.toBigDecimalOrNull() ?: return a == b
        val db = b.toBigDecimalOrNull() ?: return a == b
        return da.compareTo(db) == 0
    }
}
