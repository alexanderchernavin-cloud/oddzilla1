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
import androidx.compose.material.icons.outlined.SportsEsports
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import cc.oddzilla.app.R
import cc.oddzilla.app.common.LocalDeps
import cc.oddzilla.app.data.api.SportSummary
import cc.oddzilla.app.ui.components.EmptyState
import cc.oddzilla.app.ui.components.LiveDot
import cc.oddzilla.app.ui.components.OzGhostButton
import cc.oddzilla.app.ui.components.OzPullToRefresh
import cc.oddzilla.app.ui.theme.OzTheme
import kotlinx.coroutines.launch

@Composable
fun SportsListScreen(onSportClicked: (slug: String) -> Unit = {}) {
    val deps = LocalDeps.current
    val vm: SportsViewModel = viewModel(factory = SportsViewModel.Factory(deps))
    val state by vm.state.collectAsStateWithLifecycle()
    val colors = OzTheme.colors
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }

    Box(modifier = Modifier.fillMaxSize().background(colors.bg)) {
        when (val s = state) {
            is SportsUi.Loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator(color = colors.fg)
                    Spacer(Modifier.height(12.dp))
                    Text(
                        stringResource(R.string.sports_loading),
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.fgMuted,
                    )
                }
            }
            is SportsUi.Error -> EmptyState(
                icon = Icons.Outlined.SportsEsports,
                title = stringResource(R.string.sports_empty),
                body = s.message,
                action = { OzGhostButton(stringResource(R.string.sports_retry), onClick = vm::refresh) },
            )
            is SportsUi.Loaded -> {
                if (s.sports.isEmpty()) {
                    EmptyState(
                        icon = Icons.Outlined.SportsEsports,
                        title = stringResource(R.string.sports_empty),
                    )
                } else {
                    OzPullToRefresh(
                        isRefreshing = refreshing,
                        onRefresh = {
                            refreshing = true
                            scope.launch {
                                vm.refresh()
                                refreshing = false
                            }
                        },
                    ) {
                        LazyColumn(modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
                            items(s.sports, key = { it.id }) { sport ->
                                SportRow(
                                    sport = sport,
                                    liveCount = s.liveCounts[sport.slug] ?: 0,
                                    onClick = { onSportClicked(sport.slug) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SportRow(
    sport: SportSummary,
    liveCount: Int,
    onClick: () -> Unit,
) {
    val colors = OzTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClickLabel = "Open ${sport.name}", onClick = onClick)
            .padding(vertical = 14.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        SportIcon(brandColor = sport.brandColor)
        Column(modifier = Modifier.weight(1f)) {
            Text(sport.name, style = MaterialTheme.typography.titleMedium, color = colors.fg)
            Spacer(Modifier.height(2.dp))
            Text(
                buildString {
                    sport.matchCount?.let { append("$it matches") }
                    if (liveCount > 0) {
                        if (isNotEmpty()) append("  ·  ")
                        append("$liveCount live")
                    }
                },
                style = MaterialTheme.typography.labelMedium,
                color = colors.fgMuted,
            )
        }
        if (liveCount > 0) LiveDot()
    }
}

@Composable
private fun SportIcon(brandColor: String?) {
    val colors = OzTheme.colors
    val tint = brandColor?.let { runCatching { Color(android.graphics.Color.parseColor(it)) }.getOrNull() }
        ?: colors.borderStrong
    Box(
        modifier = Modifier
            .size(32.dp)
            .clip(CircleShape)
            .background(tint.copy(alpha = 0.15f)),
    )
}
