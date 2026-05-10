package cc.oddzilla.app.ui.screens.bets

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ReceiptLong
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import androidx.compose.ui.unit.dp
import cc.oddzilla.app.common.LocalDeps
import cc.oddzilla.app.common.formatMoney
import cc.oddzilla.app.common.formatOdds
import cc.oddzilla.app.data.api.CashoutQuote
import cc.oddzilla.app.data.api.TicketSummary
import cc.oddzilla.app.ui.components.EmptyState
import cc.oddzilla.app.ui.components.OzGhostButton
import cc.oddzilla.app.ui.components.OzPrimaryButton
import cc.oddzilla.app.ui.components.OzPullToRefresh
import cc.oddzilla.app.ui.theme.OzTheme
import kotlinx.coroutines.launch

@Composable
fun BetsScreen() {
    val deps = LocalDeps.current
    val colors = OzTheme.colors
    val scope = rememberCoroutineScope()

    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var tickets by remember { mutableStateOf<List<TicketSummary>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var tab by remember { mutableStateOf(0) }
    var quoteForTicket by remember { mutableStateOf<Pair<TicketSummary, CashoutQuote>?>(null) }
    var quoting by remember { mutableStateOf(false) }
    var quoteError by remember { mutableStateOf<String?>(null) }
    var accepting by remember { mutableStateOf(false) }

    suspend fun load() {
        try {
            tickets = deps.betsRepository.list()
            error = null
        } catch (e: Throwable) {
            error = e.message ?: "Could not load bets."
        } finally {
            loading = false
        }
    }

    LaunchedEffect(Unit) { load() }
    LaunchedEffect(Unit) {
        deps.liveOdds.ticketUpdates.collect { _ -> load() }
    }

    val active = remember(tickets) {
        tickets.filter { it.status == "pending_delay" || it.status == "accepted" }
    }
    val settled = remember(tickets) {
        tickets.filter { it.status !in setOf("pending_delay", "accepted") }
    }
    val visible = if (tab == 0) active else settled

    Column(modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(8.dp))
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TabPill("Active (${active.size})", active = tab == 0, onClick = { tab = 0 })
            TabPill("Settled (${settled.size})", active = tab == 1, onClick = { tab = 1 })
        }
        Spacer(Modifier.height(12.dp))
        Box(modifier = Modifier.fillMaxSize()) {
            when {
                loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator(color = colors.fg)
                }
                error != null && tickets.isEmpty() -> EmptyState(
                    icon = Icons.Outlined.ReceiptLong,
                    title = "Couldn't load bets",
                    body = error,
                    action = {
                        OzGhostButton("Retry", onClick = { scope.launch { loading = true; load() } })
                    },
                )
                visible.isEmpty() -> EmptyState(
                    icon = Icons.Outlined.ReceiptLong,
                    title = if (tab == 0) "No active bets" else "No settled bets yet",
                    body = if (tab == 0) "Place a bet from a match to see it here." else null,
                )
                else -> OzPullToRefresh(
                    isRefreshing = refreshing,
                    onRefresh = {
                        refreshing = true
                        scope.launch { load(); refreshing = false }
                    },
                ) {
                    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        items(visible, key = { it.id }) { ticket ->
                            TicketCard(
                                ticket = ticket,
                                onCashOut = if (tab == 0 && ticket.status == "accepted") {
                                    {
                                        quoting = true
                                        quoteError = null
                                        scope.launch {
                                            try {
                                                val q = deps.betsRepository.cashoutQuote(ticket.id)
                                                if (q.available) {
                                                    quoteForTicket = ticket to q
                                                } else {
                                                    quoteError = q.reason ?: "Cashout unavailable."
                                                }
                                            } catch (e: Throwable) {
                                                quoteError = e.message ?: "Cashout request failed."
                                            } finally {
                                                quoting = false
                                            }
                                        }
                                    }
                                } else null,
                            )
                        }
                    }
                }
            }
        }
    }

    quoteForTicket?.let { (ticket, quote) ->
        CashoutAcceptDialog(
            ticket = ticket,
            quote = quote,
            accepting = accepting,
            onConfirm = {
                accepting = true
                scope.launch {
                    try {
                        deps.betsRepository.cashoutAccept(
                            ticketId = ticket.id,
                            quoteId = quote.quoteId.orEmpty(),
                            expectedOfferMicro = quote.offerMicro.orEmpty(),
                        )
                        quoteForTicket = null
                        deps.snackbar.show("Cashed out.")
                        load()
                    } catch (e: Throwable) {
                        quoteError = e.message ?: "Could not accept cashout."
                    } finally {
                        accepting = false
                    }
                }
            },
            onDismiss = { quoteForTicket = null },
        )
    }

    quoteError?.let { msg ->
        AlertDialog(
            onDismissRequest = { quoteError = null },
            title = { Text("Cashout") },
            text = { Text(msg, color = OzTheme.colors.negative) },
            confirmButton = { OzPrimaryButton("OK", onClick = { quoteError = null }) },
        )
    }

    if (quoting) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = OzTheme.colors.fg)
        }
    }
}

@Composable
private fun TabPill(label: String, active: Boolean, onClick: () -> Unit) {
    val colors = OzTheme.colors
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(percent = 50))
            .background(if (active) colors.accent else Color.Transparent)
            .border(BorderStroke(1.dp, if (active) Color.Transparent else colors.border), RoundedCornerShape(percent = 50))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 6.dp),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = if (active) colors.accentFg else colors.fg,
        )
    }
}

@Composable
private fun TicketCard(
    ticket: TicketSummary,
    onCashOut: (() -> Unit)?,
) {
    val colors = OzTheme.colors
    val statusColor = when (ticket.status) {
        "accepted" -> colors.fg
        "settled" -> if (ticket.actualPayoutMicro?.let { it != "0" } == true) colors.positive else colors.fgMuted
        "rejected", "voided" -> colors.negative
        "cashed_out" -> colors.tierGold
        "pending_delay" -> colors.fgMuted
        else -> colors.fgMuted
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(colors.surface)
            .border(BorderStroke(1.dp, colors.border), RoundedCornerShape(12.dp))
            .padding(14.dp),
    ) {
        Row(modifier = Modifier.fillMaxWidth()) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    "${ticket.betType.replaceFirstChar(Char::titlecase)}  ·  ${ticket.selections.size} leg${if (ticket.selections.size != 1) "s" else ""}",
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.fgMuted,
                )
                Text(
                    "Stake ${formatMoney(ticket.stakeMicro, ticket.currency)}",
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.fg,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    ticket.status.replace('_', ' ').replaceFirstChar(Char::titlecase),
                    style = MaterialTheme.typography.labelMedium,
                    color = statusColor,
                )
                Text(
                    "Pot. ${formatMoney(ticket.potentialPayoutMicro, ticket.currency)}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.fg,
                )
            }
        }
        Spacer(Modifier.height(8.dp))
        ticket.selections.forEach { leg ->
            val match = leg.market
            Text(
                buildString {
                    if (match != null) append("${match.homeTeam} vs ${match.awayTeam} — ")
                    append(leg.outcomeId)
                    append("  @ ")
                    append(formatOdds(leg.oddsAtPlacement))
                },
                style = MaterialTheme.typography.bodySmall,
                color = colors.fgMuted,
            )
        }
        if (onCashOut != null) {
            Spacer(Modifier.height(10.dp))
            OzGhostButton(text = "Cash out", onClick = onCashOut, modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun CashoutAcceptDialog(
    ticket: TicketSummary,
    quote: CashoutQuote,
    accepting: Boolean,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Cash out") },
        text = {
            Column {
                Text(
                    "Offer: ${quote.offerMicro?.let { formatMoney(it, ticket.currency) } ?: "—"}",
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    "Stake: ${formatMoney(quote.ticketStakeMicro, ticket.currency)}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = OzTheme.colors.fgMuted,
                )
                quote.ticketOdds?.let { Text("Odds: ${formatOdds(it)}", color = OzTheme.colors.fgMuted) }
                if (quote.fullPayback == true) {
                    Text("Pre-match window — full stake refund.", color = OzTheme.colors.positive)
                }
                quote.expiresAt?.let { Text("Expires: $it", color = OzTheme.colors.fgDim) }
            }
        },
        confirmButton = {
            OzPrimaryButton(
                text = if (accepting) "Accepting…" else "Accept",
                onClick = onConfirm,
                enabled = !accepting && quote.quoteId != null,
            )
        },
        dismissButton = { OzGhostButton("Cancel", onClick = onDismiss) },
    )
}
