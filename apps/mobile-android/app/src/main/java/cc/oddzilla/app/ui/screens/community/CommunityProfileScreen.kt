package cc.oddzilla.app.ui.screens.community

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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.EmojiEvents
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import cc.oddzilla.app.common.LocalDeps
import cc.oddzilla.app.data.api.CommunityAchievement
import cc.oddzilla.app.data.api.CommunityProfile
import cc.oddzilla.app.data.api.CommunityTicketSummary
import cc.oddzilla.app.ui.components.EmptyState
import cc.oddzilla.app.ui.screens.sports.TopBar
import cc.oddzilla.app.ui.theme.OzTheme

@Composable
fun CommunityProfileScreen(
    nickname: String,
    onBack: () -> Unit,
    onProfileTap: (nickname: String) -> Unit,
) {
    val deps = LocalDeps.current
    val colors = OzTheme.colors

    var profile by remember { mutableStateOf<CommunityProfile?>(null) }
    var tickets by remember { mutableStateOf<List<CommunityTicketSummary>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var currency by remember { mutableStateOf("USDC") }

    LaunchedEffect(nickname, currency) {
        loading = true
        try {
            profile = deps.communityRepository.profile(nickname, currency)
            tickets = deps.communityRepository.userTickets(nickname).tickets
            error = null
        } catch (e: Throwable) {
            error = e.message ?: "Couldn't load profile."
        } finally {
            loading = false
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(colors.bg)) {
        TopBar(title = "@$nickname", onBack = onBack)
        Box(modifier = Modifier.weight(1f)) {
            when {
                loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator(color = colors.fg)
                }
                error != null -> EmptyState(
                    icon = Icons.Outlined.EmojiEvents,
                    title = "Couldn't load profile",
                    body = error,
                )
                profile != null -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    item { ProfileHeader(profile = profile!!) }
                    item {
                        CurrencyRow(
                            current = currency,
                            options = listOf("USDC", "OZ"),
                            onSelect = { currency = it },
                        )
                    }
                    item { StatsRow(profile = profile!!) }
                    if (profile!!.achievements.isNotEmpty()) {
                        item {
                            Text("Achievements", style = MaterialTheme.typography.titleMedium, color = colors.fg)
                        }
                        item { AchievementsGrid(profile!!.achievements) }
                    }
                    if (tickets.isNotEmpty()) {
                        item {
                            Text("Recent bets", style = MaterialTheme.typography.titleMedium, color = colors.fg)
                        }
                        items(tickets, key = { it.ticketId }) { t ->
                            CommunityTicketCard(
                                ticket = t,
                                onProfileTap = onProfileTap,
                                onCopyTap = null, // copy is reachable from the public feed
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ProfileHeader(profile: CommunityProfile) {
    val colors = OzTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier
                .size(56.dp)
                .clip(CircleShape)
                .background(colors.surface2)
                .border(BorderStroke(1.dp, colors.border), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                profile.nickname.take(2).uppercase(),
                style = MaterialTheme.typography.titleMedium,
                color = colors.fg,
            )
        }
        Spacer(Modifier.size(12.dp))
        Column {
            Text("@${profile.nickname}", style = MaterialTheme.typography.titleLarge, color = colors.fg)
            if (!profile.bio.isNullOrBlank()) {
                Text(profile.bio, style = MaterialTheme.typography.bodyMedium, color = colors.fgMuted)
            }
            Text("Joined ${profile.joinedAt}", style = MaterialTheme.typography.labelSmall, color = colors.fgDim)
        }
    }
}

@Composable
private fun CurrencyRow(current: String, options: List<String>, onSelect: (String) -> Unit) {
    val colors = OzTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { c ->
            val active = c == current
            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(percent = 50))
                    .background(if (active) colors.accent else Color.Transparent)
                    .border(
                        BorderStroke(1.dp, if (active) Color.Transparent else colors.border),
                        RoundedCornerShape(percent = 50),
                    )
                    .clickable { onSelect(c) }
                    .padding(horizontal = 14.dp, vertical = 6.dp),
            ) {
                Text(c, style = MaterialTheme.typography.labelMedium, color = if (active) colors.accentFg else colors.fg)
            }
        }
    }
}

@Composable
private fun StatsRow(profile: CommunityProfile) {
    val colors = OzTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(colors.surface)
            .border(BorderStroke(1.dp, colors.border), RoundedCornerShape(12.dp))
            .padding(14.dp),
    ) {
        Stat("Settled", profile.stats.settledTickets.toString(), Modifier.weight(1f))
        Stat("Wins", profile.stats.wins.toString(), Modifier.weight(1f))
        Stat("Win rate", "${profile.stats.winRatePct}%", Modifier.weight(1f))
        Stat("ROI", "${profile.stats.roiPct}%", Modifier.weight(1f))
    }
}

@Composable
private fun Stat(label: String, value: String, modifier: Modifier = Modifier) {
    val colors = OzTheme.colors
    Column(modifier = modifier) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = colors.fgMuted)
        Text(value, style = MaterialTheme.typography.titleMedium, color = colors.fg)
    }
}

// 3-column grid built from chunked rows. The achievements list is
// small (≤5 in V1) so a non-Lazy layout is simpler than nesting a
// LazyVerticalGrid inside a LazyColumn (which Compose forbids without
// fixed heights anyway).
@Composable
private fun AchievementsGrid(items: List<CommunityAchievement>) {
    val colors = OzTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items.chunked(3).forEach { rowItems ->
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                rowItems.forEach { a ->
                    Column(
                        modifier = Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(10.dp))
                            .background(colors.surface)
                            .border(BorderStroke(1.dp, colors.border), RoundedCornerShape(10.dp))
                            .padding(8.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Icon(
                            Icons.Outlined.EmojiEvents,
                            contentDescription = a.title,
                            tint = colors.tierGold,
                            modifier = Modifier.size(28.dp),
                        )
                        Text(
                            a.title,
                            style = MaterialTheme.typography.labelMedium,
                            color = colors.fg,
                            maxLines = 1,
                        )
                    }
                }
                repeat(3 - rowItems.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}
