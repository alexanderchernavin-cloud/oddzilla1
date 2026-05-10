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
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import cc.oddzilla.app.common.formatMoney
import cc.oddzilla.app.common.formatOdds
import cc.oddzilla.app.data.api.CommunityTicketSummary
import cc.oddzilla.app.ui.components.OzGhostButton
import cc.oddzilla.app.ui.theme.OzTheme

// Recent / Best Wins / per-profile feed card. One ticket as projection
// (community_tickets row), anonymised down to: bettor identity (nickname
// + avatar + bio), money summary, status, sport icons.
//
// Two presentation flavours coexist: status="accepted" tickets are
// in-flight (the "Recent" tab), settled / cashed_out / voided tickets
// carry realised P&L (the "Best Wins" tab + per-user history).

@Composable
fun CommunityTicketCard(
    ticket: CommunityTicketSummary,
    onProfileTap: (nickname: String) -> Unit,
    onCopyTap: (() -> Unit)?,
) {
    val colors = OzTheme.colors
    val statusColor = when (ticket.status) {
        "settled" -> if (ticket.profitMicro.toBigDecimalOrNull()?.signum() == 1) colors.positive else colors.fgMuted
        "cashed_out" -> colors.tierGold
        "voided" -> colors.fgMuted
        "accepted" -> colors.fg
        else -> colors.fgMuted
    }
    val statusLabel = ticket.status.replace('_', ' ').replaceFirstChar(Char::titlecase)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(colors.surface)
            .border(BorderStroke(1.dp, if (ticket.isBigWin) colors.tierGold else colors.border), RoundedCornerShape(12.dp))
            .padding(14.dp),
    ) {
        // ── Header row: bettor identity + ticket status ──────────────
        Row(verticalAlignment = Alignment.CenterVertically) {
            Avatar(nickname = ticket.nickname, modifier = Modifier
                .clickable { onProfileTap(ticket.nickname) })
            Spacer(Modifier.size(10.dp))
            Column(modifier = Modifier.weight(1f).clickable { onProfileTap(ticket.nickname) }) {
                Text(ticket.nickname, style = MaterialTheme.typography.titleSmall, color = colors.fg)
                if (!ticket.bio.isNullOrBlank()) {
                    Text(
                        ticket.bio,
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.fgDim,
                        maxLines = 1,
                    )
                }
            }
            Text(statusLabel, style = MaterialTheme.typography.labelMedium, color = statusColor)
        }
        Spacer(Modifier.height(10.dp))

        // ── Money + odds row ─────────────────────────────────────────
        Row {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    when (ticket.status) {
                        "accepted" -> "Pot. payout"
                        "cashed_out" -> "Cashed out"
                        "settled" -> if (ticket.profitMicro.toBigDecimalOrNull()?.signum() == 1) "Won" else "Settled"
                        else -> "Payout"
                    },
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.fgMuted,
                )
                Text(
                    formatMoney(ticket.payoutMicro, ticket.currency),
                    style = MaterialTheme.typography.titleLarge,
                    color = if (ticket.isBigWin) colors.tierGold else colors.fg,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    "${ticket.numLegs} leg${if (ticket.numLegs != 1) "s" else ""}  ·  @${formatOdds(ticket.totalOdds)}",
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.fgMuted,
                )
                Text(
                    "Stake ${formatMoney(ticket.stakeMicro, ticket.currency)}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.fg,
                )
            }
        }

        if (onCopyTap != null) {
            Spacer(Modifier.height(10.dp))
            OzGhostButton(
                text = "Copy this bet",
                onClick = onCopyTap,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
internal fun Avatar(nickname: String, modifier: Modifier = Modifier) {
    val colors = OzTheme.colors
    val initials = nickname.take(2).uppercase()
    Box(
        modifier = modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(colors.surface2)
            .border(BorderStroke(1.dp, colors.border), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(initials, style = MaterialTheme.typography.labelMedium, color = colors.fg)
    }
}
