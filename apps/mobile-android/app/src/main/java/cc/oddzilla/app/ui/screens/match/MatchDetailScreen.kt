package cc.oddzilla.app.ui.screens.match

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.SportsScore
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cc.oddzilla.app.bet.SlipSelection
import cc.oddzilla.app.common.LocalDeps
import cc.oddzilla.app.common.formatOdds
import cc.oddzilla.app.data.api.MarketDto
import cc.oddzilla.app.data.api.MatchHeader
import cc.oddzilla.app.data.api.OutcomeDto
import cc.oddzilla.app.data.ws.OddsKey
import cc.oddzilla.app.data.ws.OddsTick
import cc.oddzilla.app.ui.components.EmptyState
import cc.oddzilla.app.ui.components.LiveDot
import cc.oddzilla.app.ui.components.OzGhostButton
import cc.oddzilla.app.ui.components.OzPullToRefresh
import cc.oddzilla.app.ui.screens.sports.TopBar
import cc.oddzilla.app.ui.theme.OzTheme

@Composable
fun MatchDetailScreen(
    matchId: String,
    onBack: () -> Unit,
    onSlipPeekTap: () -> Unit,
) {
    val deps = LocalDeps.current
    val colors = OzTheme.colors

    var match by remember { mutableStateOf<MatchHeader?>(null) }
    var markets by remember { mutableStateOf<List<MarketDto>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var refreshKey by remember { mutableStateOf(0) }

    suspend fun load() {
        try {
            val resp = deps.catalogRepository.getMatch(matchId)
            match = resp.match
            markets = resp.markets
            error = null
        } catch (e: Throwable) {
            error = e.message ?: "Could not load match."
        }
    }

    LaunchedEffect(matchId, refreshKey) {
        loading = true
        load()
        loading = false
    }

    LaunchedEffect(matchId) { deps.liveOdds.subscribe(listOf(matchId)) }
    androidx.compose.runtime.DisposableEffect(matchId) {
        onDispose { deps.liveOdds.unsubscribe(listOf(matchId)) }
    }
    val oddsMap by deps.liveOdds.odds.collectAsStateWithLifecycle()
    val liveStatuses by deps.liveOdds.matchStatus.collectAsStateWithLifecycle()

    val scopeGroups by remember(markets) {
        derivedStateOf {
            markets
                .filter { it.outcomes.isNotEmpty() }
                .groupBy { it.scope?.label ?: "Match" }
                .toList()
                .sortedBy { (_, list) -> list.firstOrNull()?.scope?.order ?: 0 }
        }
    }
    var selectedScope by remember { mutableStateOf(0) }

    // groupLineMarkets is O(n) but we only want to recompute on scope or
    // markets change, not every recomposition (live odds tick). Hoisted
    // here because LazyColumn's `LazyListScope` body isn't @Composable
    // and can't host `remember`.
    val groupedMarkets = remember(scopeGroups, selectedScope) {
        if (scopeGroups.isEmpty()) emptyList()
        else groupLineMarkets(
            scopeGroups[selectedScope.coerceAtMost(scopeGroups.lastIndex)].second,
        )
    }

    val slipState by deps.betSlip.state.collectAsStateWithLifecycle()
    val slipCount = slipState.selections.size

    Column(modifier = Modifier.fillMaxSize().background(colors.bg)) {
        TopBar(
            title = match?.let { "${it.homeTeam} vs ${it.awayTeam}" } ?: "Match",
            onBack = onBack,
        )
        Box(modifier = Modifier.weight(1f)) {
            when {
                loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator(color = colors.fg)
                }
                error != null && match == null -> EmptyState(
                    icon = Icons.Outlined.SportsScore,
                    title = "Couldn't load match",
                    body = error,
                    action = {
                        OzGhostButton("Retry", onClick = { refreshKey += 1 })
                    },
                )
                match != null -> {
                    val live = match!!.status == "live" || liveStatuses[matchId] == "live"
                    OzPullToRefresh(
                        isRefreshing = refreshing,
                        onRefresh = {
                            refreshing = true
                            // Trigger LaunchedEffect rerun
                            refreshKey += 1
                            // Stop the spinner once the load() call kicks off — the
                            // LaunchedEffect manages `loading`. Best-effort, the visible
                            // refresh indicator dismisses fast either way.
                            refreshing = false
                        },
                    ) {
                        LazyColumn(modifier = Modifier.fillMaxSize()) {
                            item {
                                MatchHeaderCard(match = match!!, live = live)
                            }
                            if (live) {
                                item {
                                    LiveScoreboard(
                                        homeTeam = match!!.homeTeam,
                                        awayTeam = match!!.awayTeam,
                                        rawScore = match!!.liveScore,
                                        modifier = Modifier.padding(horizontal = 16.dp),
                                    )
                                    Spacer(Modifier.height(12.dp))
                                }
                            }
                            if (match!!.streams.isNotEmpty()) {
                                item {
                                    MatchStreamEmbed(streams = match!!.streams)
                                    Spacer(Modifier.height(12.dp))
                                }
                            }
                            if (scopeGroups.isNotEmpty()) {
                                item {
                                    ScopeTabs(
                                        labels = scopeGroups.map { it.first },
                                        selected = selectedScope.coerceAtMost(scopeGroups.lastIndex),
                                        onSelect = { selectedScope = it },
                                    )
                                }
                                items(groupedMarkets, key = { it.groupKey }) { group ->
                                    MarketGroupCard(
                                        group = group,
                                        matchId = matchId,
                                        oddsMap = oddsMap,
                                        isSelected = { marketId, outcomeId ->
                                            deps.betSlip.isSelected(matchId, marketId, outcomeId)
                                        },
                                        onOutcomeTap = { market, outcome ->
                                            val livePrice = oddsMap[OddsKey(matchId, market.id, outcome.outcomeId)]?.odds
                                            deps.betSlip.add(
                                                SlipSelection(
                                                    matchId = matchId,
                                                    marketId = market.id,
                                                    outcomeId = outcome.outcomeId,
                                                    odds = livePrice ?: outcome.publishedOdds.orEmpty(),
                                                    homeTeam = match!!.homeTeam,
                                                    awayTeam = match!!.awayTeam,
                                                    marketLabel = market.name,
                                                    outcomeLabel = outcome.name,
                                                    sportSlug = match!!.sportSlug,
                                                    active = outcome.active,
                                                ),
                                            )
                                        },
                                    )
                                }
                            } else {
                                item {
                                    EmptyState(
                                        icon = Icons.Outlined.SportsScore,
                                        title = "No active markets",
                                        body = "Markets will appear when the match goes live.",
                                    )
                                }
                            }
                            item { Spacer(Modifier.height(72.dp)) } // headroom for peek bar
                        }
                    }
                }
            }
        }
        if (slipCount > 0) BetSlipPeek(slipCount = slipCount, onTap = onSlipPeekTap)
    }
}

@Composable
private fun MatchHeaderCard(match: MatchHeader, live: Boolean) {
    val colors = OzTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (live) LiveDot()
            Text(
                buildString {
                    append(match.tournamentName ?: match.sportName)
                    if (live) {
                        if (isNotEmpty()) append("  ·  ")
                        append("LIVE")
                    } else if (match.scheduledAt != null) {
                        if (isNotEmpty()) append("  ·  ")
                        append(match.scheduledAt)
                    }
                },
                style = MaterialTheme.typography.labelMedium,
                color = if (live) colors.live else colors.fgMuted,
            )
        }
        Spacer(Modifier.height(8.dp))
        Text(match.homeTeam, style = MaterialTheme.typography.titleLarge, color = colors.fg)
        Text("vs", style = MaterialTheme.typography.bodySmall, color = colors.fgDim)
        Text(match.awayTeam, style = MaterialTheme.typography.titleLarge, color = colors.fg)
    }
}

@Composable
private fun ScopeTabs(labels: List<String>, selected: Int, onSelect: (Int) -> Unit) {
    val colors = OzTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        labels.forEachIndexed { index, label ->
            val active = index == selected
            val bg = if (active) colors.accent else Color.Transparent
            val fg = if (active) colors.accentFg else colors.fg
            val border = if (active) Color.Transparent else colors.border
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(percent = 50))
                    .background(bg)
                    .border(BorderStroke(1.dp, border), RoundedCornerShape(percent = 50))
                    .clickable { onSelect(index) }
                    .padding(horizontal = 14.dp, vertical = 6.dp),
            ) {
                Text(label, style = MaterialTheme.typography.labelMedium, color = fg)
            }
        }
    }
}

// ── Line-market grouping ─────────────────────────────────────────────
//
// Markets with a `lineKey` (Totals, Handicaps, …) collapse into one
// card with the base name as header and one row per line value.

internal data class MarketGroup(
    val groupKey: String,
    val baseName: String,
    val isLineGroup: Boolean,
    val markets: List<MarketDto>,
)

internal fun groupLineMarkets(markets: List<MarketDto>): List<MarketGroup> {
    val out = LinkedHashMap<String, MutableList<MarketDto>>()
    val labelByKey = HashMap<String, String>()
    val isLineByKey = HashMap<String, Boolean>()

    for (m in markets) {
        val key = m.lineKey ?: m.id
        out.getOrPut(key) { mutableListOf() }.add(m)
        if (key !in labelByKey) {
            labelByKey[key] = m.baseName ?: m.name
            isLineByKey[key] = m.lineKey != null
        }
    }
    return out.map { (k, ms) ->
        MarketGroup(
            groupKey = k,
            baseName = labelByKey[k] ?: ms.first().name,
            isLineGroup = isLineByKey[k] == true,
            markets = ms.sortedBy { it.lineValue?.toDoubleOrNull() ?: 0.0 },
        )
    }
}

@Composable
private fun MarketGroupCard(
    group: MarketGroup,
    matchId: String,
    oddsMap: Map<OddsKey, OddsTick>,
    isSelected: (marketId: String, outcomeId: String) -> Boolean,
    onOutcomeTap: (MarketDto, OutcomeDto) -> Unit,
) {
    val colors = OzTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(group.baseName, style = MaterialTheme.typography.titleMedium, color = colors.fg)
            if (group.markets.all { it.status != 1 }) {
                Text("Suspended", style = MaterialTheme.typography.labelSmall, color = colors.negative)
            }
        }
        Spacer(Modifier.height(6.dp))
        if (group.isLineGroup) {
            // One row per line value: "Over 2.5  Under 2.5"
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                group.markets.forEach { market ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            market.lineValue?.let { "${labelFor(market.lineSpec)} $it" } ?: "",
                            style = MaterialTheme.typography.labelMedium,
                            color = colors.fgMuted,
                            modifier = Modifier.widthIn(min = 64.dp).padding(end = 8.dp),
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            market.outcomes.forEach { outcome ->
                                val tick = oddsMap[OddsKey(matchId, market.id, outcome.outcomeId)]
                                val odds = tick?.odds ?: outcome.publishedOdds
                                val active = (tick?.active ?: outcome.active) && market.status == 1
                                OutcomeChip(
                                    label = outcome.name,
                                    odds = odds,
                                    active = active,
                                    selected = isSelected(market.id, outcome.outcomeId),
                                    onClick = { if (active) onOutcomeTap(market, outcome) },
                                )
                            }
                        }
                    }
                }
            }
        } else {
            val market = group.markets.first()
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                market.outcomes.forEach { outcome ->
                    val tick = oddsMap[OddsKey(matchId, market.id, outcome.outcomeId)]
                    val odds = tick?.odds ?: outcome.publishedOdds
                    val active = (tick?.active ?: outcome.active) && market.status == 1
                    OutcomeChip(
                        label = outcome.name,
                        odds = odds,
                        active = active,
                        selected = isSelected(market.id, outcome.outcomeId),
                        onClick = { if (active) onOutcomeTap(market, outcome) },
                    )
                }
            }
        }
        Spacer(Modifier.height(6.dp))
        Box(modifier = Modifier.fillMaxWidth().height(1.dp).background(colors.hairline))
    }
}

private fun labelFor(lineSpec: String?): String = when (lineSpec) {
    "threshold" -> "Total"
    "handicap" -> "Handicap"
    else -> ""
}

@Composable
private fun OutcomeChip(
    label: String,
    odds: String?,
    active: Boolean,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val colors = OzTheme.colors
    val bg = if (selected) colors.accent else colors.surface
    val fg = when {
        selected -> colors.accentFg
        !active -> colors.fgDim
        else -> colors.fg
    }
    val border = if (selected) Color.Transparent else colors.border
    Column(
        modifier = Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(bg)
            .border(BorderStroke(1.dp, border), RoundedCornerShape(10.dp))
            .clickable(enabled = active, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = fg)
        Text(formatOdds(odds), style = MaterialTheme.typography.titleMedium, color = fg)
    }
}

@Composable
private fun BetSlipPeek(slipCount: Int, onTap: () -> Unit) {
    val colors = OzTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(12.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(colors.fg)
            .clickable(onClick = onTap)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier
                .size(28.dp)
                .clip(CircleShape)
                .background(colors.bg),
            contentAlignment = Alignment.Center,
        ) {
            Text("$slipCount", style = MaterialTheme.typography.labelLarge, color = colors.fg)
        }
        Text("View bet slip", style = MaterialTheme.typography.titleMedium, color = colors.bg)
    }
}
