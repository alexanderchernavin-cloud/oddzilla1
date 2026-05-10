package cc.oddzilla.app.ui.screens.bet

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cc.oddzilla.app.bet.SlipMode
import cc.oddzilla.app.bet.SlipSelection
import cc.oddzilla.app.common.LocalDeps
import cc.oddzilla.app.common.formatMoney
import cc.oddzilla.app.common.formatOdds
import cc.oddzilla.app.ui.components.OzGhostButton
import cc.oddzilla.app.ui.components.OzPrimaryButton
import cc.oddzilla.app.ui.theme.OzTheme
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BetSlipSheet(
    onDismiss: () -> Unit,
) {
    val deps = LocalDeps.current
    val state by deps.betSlip.state.collectAsStateWithLifecycle()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val colors = OzTheme.colors

    var placedSummary by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(state.selections.size, state.placing) {
        if (state.selections.isEmpty() && !state.placing && placedSummary == null) {
            // Sheet stays open even when empty so the user can dismiss
            // explicitly. No auto-close.
        }
    }

    val anyPending = state.selections.any { it.pendingOdds != null }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = colors.bg,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 200.dp)
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            Text("Bet slip", style = MaterialTheme.typography.titleLarge, color = colors.fg)
            Spacer(Modifier.height(8.dp))

            if (state.selections.isEmpty() && placedSummary == null) {
                Text(
                    "Pick an outcome from a match to add it here.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.fgMuted,
                )
                return@Column
            }

            placedSummary?.let { summary ->
                Text(summary, style = MaterialTheme.typography.bodyMedium, color = colors.positive)
                Spacer(Modifier.height(12.dp))
                OzGhostButton("Done", onClick = onDismiss, modifier = Modifier.fillMaxWidth())
                return@Column
            }

            // ── Drift banner (shown only when at least one leg has a pending change) ──
            if (anyPending) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .background(colors.surface2)
                        .border(BorderStroke(1.dp, colors.tierGold), RoundedCornerShape(10.dp))
                        .padding(12.dp),
                ) {
                    Text(
                        "Odds changed since you tapped. Review and accept before placing.",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.fg,
                    )
                }
                Spacer(Modifier.height(8.dp))
            }

            // ── Selections list ──
            LazyColumn(
                modifier = Modifier.heightIn(max = 240.dp).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(state.selections, key = { it.matchId + it.marketId + it.outcomeId }) { sel ->
                    SelectionRow(sel = sel, onRemove = {
                        deps.betSlip.remove(sel.matchId, sel.marketId, sel.outcomeId)
                    })
                }
            }
            Spacer(Modifier.height(12.dp))

            // ── Mode toggle ──
            if (state.selections.size >= 2) {
                ModeToggle(mode = state.mode, onSelect = deps.betSlip::setMode)
                Spacer(Modifier.height(8.dp))
            }

            // ── Currency toggle ──
            CurrencyToggle(currency = state.currency, onSelect = deps.betSlip::setCurrency)
            Spacer(Modifier.height(12.dp))

            // ── Stake ──
            OutlinedTextField(
                value = state.stakeText,
                onValueChange = deps.betSlip::setStakeText,
                label = { Text("Stake (${state.currency})") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.placing,
            )

            val payoutMicro = remember(state.selections, state.mode, state.stakeText) {
                deps.betSlip.potentialPayoutMicro()
            }
            val combo = remember(state.selections, state.mode) { deps.betSlip.comboOdds() }
            Spacer(Modifier.height(12.dp))
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column {
                    Text("Potential payout", style = MaterialTheme.typography.labelMedium, color = colors.fgMuted)
                    Text(
                        payoutMicro?.let { formatMoney(it, state.currency) } ?: "—",
                        style = MaterialTheme.typography.titleLarge,
                        color = colors.fg,
                    )
                }
                if (state.mode == SlipMode.Combo && combo != null) {
                    Column(horizontalAlignment = Alignment.End) {
                        Text("Combo odds", style = MaterialTheme.typography.labelMedium, color = colors.fgMuted)
                        Text(combo.toPlainString(), style = MaterialTheme.typography.titleLarge, color = colors.fg)
                    }
                }
            }

            state.lastError?.let { msg ->
                Spacer(Modifier.height(8.dp))
                Text(msg, style = MaterialTheme.typography.bodySmall, color = colors.negative)
            }

            Spacer(Modifier.height(16.dp))

            // ── Place / Accept-and-place ──
            // When any leg has a pendingOdds, the primary button accepts
            // the new prices. The user can review the per-row delta and
            // tap a single Accept to copy pending → odds across all
            // legs, then tap Place. We expose Accept + Place as one
            // tap when only the drift exists; otherwise the standard
            // Place button.
            if (anyPending) {
                OzPrimaryButton(
                    text = "Accept new odds",
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !state.placing,
                    onClick = { deps.betSlip.acceptPendingOdds() },
                )
                Spacer(Modifier.height(8.dp))
            }
            OzPrimaryButton(
                text = if (state.placing) "Placing…" else "Place bet",
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.placing && !anyPending && state.selections.isNotEmpty(),
                onClick = {
                    scope.launch {
                        val tickets = deps.betSlip.place()
                        if (tickets != null && tickets.isNotEmpty()) {
                            placedSummary = if (tickets.size == 1) {
                                "Bet placed (${tickets[0].status})."
                            } else {
                                "${tickets.size} bets placed."
                            }
                        }
                    }
                },
            )
            Spacer(Modifier.height(8.dp))
            OzGhostButton("Clear", onClick = { deps.betSlip.clear() }, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
private fun SelectionRow(sel: SlipSelection, onRemove: () -> Unit) {
    val colors = OzTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(colors.surface)
            .border(
                BorderStroke(1.dp, if (sel.pendingOdds != null) colors.tierGold else colors.border),
                RoundedCornerShape(10.dp),
            )
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                "${sel.homeTeam} vs ${sel.awayTeam}",
                style = MaterialTheme.typography.labelMedium,
                color = colors.fgMuted,
            )
            Text(sel.outcomeLabel, style = MaterialTheme.typography.titleMedium, color = colors.fg)
            Text(sel.marketLabel, style = MaterialTheme.typography.labelMedium, color = colors.fgDim)
        }
        Column(horizontalAlignment = Alignment.End) {
            if (sel.pendingOdds != null) {
                Text(
                    formatOdds(sel.odds),
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.fgDim,
                )
                Text(
                    "→ ${formatOdds(sel.pendingOdds)}",
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.tierGold,
                )
            } else {
                Text(formatOdds(sel.odds), style = MaterialTheme.typography.titleMedium, color = colors.fg)
            }
        }
        Spacer(Modifier.padding(horizontal = 4.dp))
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(percent = 50))
                .background(colors.surface2)
                .clickable(
                    onClickLabel = "Remove ${sel.outcomeLabel} from slip",
                    onClick = onRemove,
                )
                .padding(horizontal = 10.dp, vertical = 6.dp),
        ) {
            Text("✕", style = MaterialTheme.typography.labelMedium, color = colors.fgMuted)
        }
    }
}

@Composable
private fun ModeToggle(mode: SlipMode, onSelect: (SlipMode) -> Unit) {
    SegmentedToggle(
        labels = listOf("Single", "Combo"),
        selectedIndex = if (mode == SlipMode.Single) 0 else 1,
        onSelect = { onSelect(if (it == 0) SlipMode.Single else SlipMode.Combo) },
    )
}

@Composable
private fun CurrencyToggle(currency: String, onSelect: (String) -> Unit) {
    val labels = listOf("USDC", "OZ")
    SegmentedToggle(
        labels = labels,
        selectedIndex = labels.indexOf(currency).coerceAtLeast(0),
        onSelect = { onSelect(labels[it]) },
    )
}

@Composable
private fun SegmentedToggle(
    labels: List<String>,
    selectedIndex: Int,
    onSelect: (Int) -> Unit,
) {
    val colors = OzTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(percent = 50))
            .background(colors.surface2)
            .padding(2.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        labels.forEachIndexed { index, label ->
            val active = index == selectedIndex
            val bg = if (active) colors.accent else Color.Transparent
            val fg = if (active) colors.accentFg else colors.fg
            Box(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(percent = 50))
                    .background(bg)
                    .clickable { onSelect(index) }
                    .padding(vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(label, style = MaterialTheme.typography.labelMedium, color = fg)
            }
        }
    }
}
