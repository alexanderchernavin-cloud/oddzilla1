package cc.oddzilla.app.ui.screens.sports

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowBack
import androidx.compose.material.icons.outlined.SportsEsports
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cc.oddzilla.app.common.LocalDeps
import cc.oddzilla.app.common.formatOdds
import cc.oddzilla.app.data.api.MatchListItem
import cc.oddzilla.app.data.api.SportSummary
import cc.oddzilla.app.ui.components.EmptyState
import cc.oddzilla.app.ui.components.LiveDot
import cc.oddzilla.app.ui.components.OzGhostButton
import cc.oddzilla.app.ui.components.OzPullToRefresh
import cc.oddzilla.app.ui.theme.OzTheme
import kotlinx.coroutines.launch

@Composable
fun SportDetailScreen(
    slug: String,
    onBack: () -> Unit,
    onMatchClicked: (matchId: String) -> Unit,
) {
    val deps = LocalDeps.current
    val colors = OzTheme.colors
    val scope = rememberCoroutineScope()

    var sport by remember { mutableStateOf<SportSummary?>(null) }
    var matches by remember { mutableStateOf<List<MatchListItem>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        try {
            val resp = deps.catalogRepository.getSport(slug)
            sport = resp.sport
            matches = resp.matches
            error = null
        } catch (e: Throwable) {
            error = e.message ?: "Could not load sport."
        }
    }

    LaunchedEffect(slug) {
        loading = true
        load()
        loading = false
    }

    val matchIds = remember(matches) { matches.map { it.id } }
    LaunchedEffect(matchIds) { deps.liveOdds.subscribe(matchIds) }
    androidx.compose.runtime.DisposableEffect(matchIds) {
        onDispose { deps.liveOdds.unsubscribe(matchIds) }
    }
    val oddsMap by deps.liveOdds.odds.collectAsStateWithLifecycle()

    Column(modifier = Modifier.fillMaxSize().background(colors.bg)) {
        TopBar(title = sport?.name ?: slug, onBack = onBack)
        Box(modifier = Modifier.fillMaxSize()) {
            when {
                loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator(color = colors.fg)
                }
                error != null && matches.isEmpty() -> EmptyState(
                    icon = Icons.Outlined.SportsEsports,
                    title = "Couldn't load matches",
                    body = error,
                    action = {
                        OzGhostButton("Retry", onClick = {
                            scope.launch { loading = true; load(); loading = false }
                        })
                    },
                )
                matches.isEmpty() -> EmptyState(
                    icon = Icons.Outlined.SportsEsports,
                    title = "No matches scheduled.",
                )
                else -> OzPullToRefresh(
                    isRefreshing = refreshing,
                    onRefresh = {
                        refreshing = true
                        scope.launch { load(); refreshing = false }
                    },
                ) {
                    LazyColumn(modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
                        items(matches, key = { it.id }) { m ->
                            MatchRow(match = m, oddsMap = oddsMap, onClick = { onMatchClicked(m.id) })
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun TopBar(title: String, onBack: () -> Unit) {
    val colors = OzTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack) {
            Icon(Icons.Outlined.ArrowBack, contentDescription = "Back", tint = colors.fg)
        }
        Text(
            title,
            style = MaterialTheme.typography.titleLarge,
            color = colors.fg,
            modifier = Modifier.padding(start = 4.dp),
        )
    }
}

@Composable
private fun MatchRow(
    match: MatchListItem,
    oddsMap: Map<cc.oddzilla.app.data.ws.OddsKey, cc.oddzilla.app.data.ws.OddsTick>,
    onClick: () -> Unit,
) {
    val colors = OzTheme.colors
    val isLive = match.status == "live"
    val mw = match.matchWinner
    val homeTick = mw?.home?.let {
        oddsMap[cc.oddzilla.app.data.ws.OddsKey(match.id, mw.marketId, it.outcomeId)]
    }
    val awayTick = mw?.away?.let {
        oddsMap[cc.oddzilla.app.data.ws.OddsKey(match.id, mw.marketId, it.outcomeId)]
    }
    val homeOdds = homeTick?.odds ?: mw?.home?.odds
    val awayOdds = awayTick?.odds ?: mw?.away?.odds

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClickLabel = "Open ${match.homeTeam} vs ${match.awayTeam}", onClick = onClick)
            .padding(vertical = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (isLive) LiveDot()
            Text(
                buildString {
                    append(match.tournamentName ?: "")
                    if (isLive) {
                        if (isNotEmpty()) append("  ·  ")
                        append("LIVE")
                    }
                },
                style = MaterialTheme.typography.labelMedium,
                color = if (isLive) colors.live else colors.fgMuted,
            )
        }
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                TeamRow(name = match.homeTeam, color = null)
                Spacer(Modifier.height(4.dp))
                TeamRow(name = match.awayTeam, color = null)
            }
            Column(horizontalAlignment = Alignment.End) {
                OddsCell(label = "1", odds = homeOdds)
                Spacer(Modifier.height(4.dp))
                OddsCell(label = "2", odds = awayOdds)
            }
        }
    }
}

@Composable
private fun TeamRow(name: String, color: Color?) {
    val colors = OzTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(
            modifier = Modifier
                .size(20.dp)
                .clip(CircleShape)
                .background((color ?: colors.borderStrong).copy(alpha = 0.15f)),
        )
        Text(name, style = MaterialTheme.typography.bodyMedium, color = colors.fg)
    }
}

@Composable
private fun OddsCell(label: String, odds: String?) {
    val colors = OzTheme.colors
    Row(
        modifier = Modifier.padding(start = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = colors.fgMuted)
        Text(formatOdds(odds), style = MaterialTheme.typography.titleMedium, color = colors.fg)
    }
}
