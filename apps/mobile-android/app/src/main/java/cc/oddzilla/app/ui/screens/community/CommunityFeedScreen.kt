package cc.oddzilla.app.ui.screens.community

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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
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
import cc.oddzilla.app.bet.SlipSelection
import cc.oddzilla.app.common.LocalDeps
import cc.oddzilla.app.data.api.CommunityTicketSummary
import cc.oddzilla.app.data.api.SportSummary
import cc.oddzilla.app.ui.components.EmptyState
import cc.oddzilla.app.ui.components.OzGhostButton
import cc.oddzilla.app.ui.components.OzPullToRefresh
import cc.oddzilla.app.ui.theme.OzTheme
import kotlinx.coroutines.launch

private enum class FeedTab(val sortKey: String, val label: String) {
    Recent("recent", "Recent"),
    Best("best", "Best wins"),
}

private val CURRENCY_OPTIONS = listOf("All", "USDC", "OZ")
private const val ALL_SPORTS = "All"

@Composable
fun CommunityFeedScreen(onProfileTap: (nickname: String) -> Unit, onSlipUpdated: () -> Unit) {
    val deps = LocalDeps.current
    val scope = rememberCoroutineScope()
    val colors = OzTheme.colors

    var tab by remember { mutableStateOf(FeedTab.Recent) }
    var currency by remember { mutableStateOf("All") }
    var sport by remember { mutableStateOf(ALL_SPORTS) }
    var sportOptions by remember { mutableStateOf<List<SportSummary>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var page by remember { mutableStateOf(1) }
    var hasMore by remember { mutableStateOf(false) }
    var tickets by remember { mutableStateOf<List<CommunityTicketSummary>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }

    suspend fun load(replace: Boolean) {
        if (replace) {
            page = 1
            tickets = emptyList()
        }
        try {
            val resp = deps.communityRepository.feed(
                sort = tab.sortKey,
                currency = currency.takeIf { it != "All" },
                sportSlug = sport.takeIf { it != ALL_SPORTS },
                page = page,
            )
            tickets = if (replace) resp.tickets else tickets + resp.tickets
            hasMore = resp.hasMore
            error = null
        } catch (e: Throwable) {
            error = e.message ?: "Could not load community feed."
        }
    }

    // One-shot pull of the sport list. The community feed accepts any
    // valid sport slug; we surface the current set of catalog sports
    // as filter pills so the user can scope to e.g. CS2 only.
    LaunchedEffect(Unit) {
        runCatching { deps.catalogRepository.listSports() }
            .onSuccess { sportOptions = it }
    }

    LaunchedEffect(tab, currency, sport) {
        loading = true
        load(replace = true)
        loading = false
    }

    val listState = rememberLazyListState()
    val nearEnd by remember {
        derivedStateOf {
            val total = listState.layoutInfo.totalItemsCount
            val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            total > 0 && lastVisible >= total - 3
        }
    }
    LaunchedEffect(nearEnd, hasMore) {
        if (nearEnd && hasMore && !loading && !refreshing) {
            page += 1
            load(replace = false)
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(colors.bg)) {
        // Recent / Best tabs.
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            FeedTab.entries.forEach { t ->
                Pill(label = t.label, active = t == tab, onClick = { tab = t })
            }
        }

        // Currency filter row.
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            CURRENCY_OPTIONS.forEach { c ->
                Pill(label = c, active = c == currency, onClick = { currency = c })
            }
        }

        // Sport filter row — horizontally scrollable since the list of
        // active sports can run to a dozen+ slugs (CS2, Dota 2, LoL,
        // Valorant, eFootball, …). "All" sits on the left, the rest are
        // alphabetised by name.
        if (sportOptions.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Pill(label = ALL_SPORTS, active = sport == ALL_SPORTS, onClick = { sport = ALL_SPORTS })
                sportOptions.sortedBy { it.name }.forEach { s ->
                    Pill(label = s.name, active = sport == s.slug, onClick = { sport = s.slug })
                }
            }
        } else {
            Spacer(Modifier.height(8.dp))
        }

        Box(modifier = Modifier.weight(1f)) {
            when {
                loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator(color = colors.fg)
                }
                error != null && tickets.isEmpty() -> EmptyState(
                    icon = Icons.Outlined.Forum,
                    title = "Couldn't load feed",
                    body = error,
                    action = {
                        OzGhostButton("Retry", onClick = {
                            scope.launch { loading = true; load(replace = true); loading = false }
                        })
                    },
                )
                tickets.isEmpty() -> EmptyState(
                    icon = Icons.Outlined.Forum,
                    title = if (tab == FeedTab.Recent) "No public bets yet" else "No big wins this week",
                    body = "Bettors who go public show up here.",
                )
                else -> OzPullToRefresh(
                    isRefreshing = refreshing,
                    onRefresh = {
                        refreshing = true
                        scope.launch {
                            load(replace = true)
                            refreshing = false
                        }
                    },
                ) {
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(tickets, key = { it.ticketId }) { ticket ->
                            CommunityTicketCard(
                                ticket = ticket,
                                onProfileTap = onProfileTap,
                                onCopyTap = if (ticket.status == "accepted" || ticket.status == "settled" || ticket.status == "cashed_out") {
                                    {
                                        scope.launch {
                                            try {
                                                val resp = deps.communityRepository.copy(ticket.ticketId)
                                                if (resp.selections.isEmpty()) {
                                                    deps.snackbar.show("This bet has no copyable legs.")
                                                } else {
                                                    var added = 0
                                                    resp.selections.forEach { sel ->
                                                        if (sel.available) {
                                                            deps.betSlip.add(
                                                                SlipSelection(
                                                                    matchId = sel.matchId,
                                                                    marketId = sel.marketId,
                                                                    outcomeId = sel.outcomeId,
                                                                    odds = sel.odds,
                                                                    homeTeam = sel.homeTeam,
                                                                    awayTeam = sel.awayTeam,
                                                                    marketLabel = sel.marketLabel,
                                                                    outcomeLabel = sel.outcomeLabel,
                                                                    sportSlug = sel.sportSlug,
                                                                    active = true,
                                                                ),
                                                            )
                                                            added += 1
                                                        }
                                                    }
                                                    if (added == 0) {
                                                        deps.snackbar.show("All of these legs have settled — nothing to copy.")
                                                    } else {
                                                        deps.snackbar.show(
                                                            "$added leg${if (added != 1) "s" else ""} added to your slip.",
                                                            actionLabel = "View",
                                                        )
                                                        onSlipUpdated()
                                                    }
                                                }
                                            } catch (e: Throwable) {
                                                deps.snackbar.show(e.message ?: "Couldn't copy this bet.")
                                            }
                                        }
                                    }
                                } else null,
                            )
                        }
                        if (hasMore) {
                            item {
                                Box(modifier = Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) {
                                    CircularProgressIndicator(color = colors.fgDim)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Pill(label: String, active: Boolean, onClick: () -> Unit) {
    val colors = OzTheme.colors
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(percent = 50))
            .background(if (active) colors.accent else Color.Transparent)
            .border(BorderStroke(1.dp, if (active) Color.Transparent else colors.border), RoundedCornerShape(percent = 50))
            .clickable(onClickLabel = "Filter by $label", onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 6.dp),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = if (active) colors.accentFg else colors.fg,
        )
    }
}
