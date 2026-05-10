package cc.oddzilla.app.ui.screens.match

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cc.oddzilla.app.ui.theme.OzTheme
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray

// Per-map live scoreboard mirroring the web `MapScoreboard`. Persisted
// shape (matches.live_score jsonb) carries:
//   { home, away, currentMap?, maps?: [{ map, home, away, winner? }] }
//
// We read defensively — anything missing falls through gracefully so a
// partial broker payload doesn't crash the screen.

private data class MapScore(
    val map: Int,
    val home: Int,
    val away: Int,
    val winner: String?,
)

private data class ParsedScore(
    val homeOverall: Int?,
    val awayOverall: Int?,
    val currentMap: Int?,
    val maps: List<MapScore>,
)

private fun JsonElement.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonObject.intOrNull(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull
private fun JsonObject.stringOrNull(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

private fun parseScore(raw: JsonElement?): ParsedScore? {
    val obj = raw?.asObjectOrNull() ?: return null
    val mapsArr = (obj["maps"] as? JsonElement)?.let {
        runCatching { it.jsonArray }.getOrNull()
    }
    val maps = mapsArr?.mapNotNull { e ->
        val m = e.asObjectOrNull() ?: return@mapNotNull null
        val map = m.intOrNull("map") ?: return@mapNotNull null
        val home = m.intOrNull("home") ?: 0
        val away = m.intOrNull("away") ?: 0
        MapScore(map, home, away, m.stringOrNull("winner"))
    }.orEmpty()
    return ParsedScore(
        homeOverall = obj.intOrNull("home"),
        awayOverall = obj.intOrNull("away"),
        currentMap = obj.intOrNull("currentMap"),
        maps = maps,
    )
}

@Composable
fun LiveScoreboard(
    homeTeam: String,
    awayTeam: String,
    rawScore: JsonElement?,
    modifier: Modifier = Modifier,
) {
    val parsed = parseScore(rawScore) ?: return
    val colors = OzTheme.colors

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(colors.surface)
            .border(BorderStroke(1.dp, colors.border), RoundedCornerShape(12.dp))
            .padding(14.dp),
    ) {
        // Top row: team names + overall map score (e.g. 2-1 in a Bo5).
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(homeTeam, style = MaterialTheme.typography.titleMedium, color = colors.fg, modifier = Modifier.weight(1f))
            Text(
                buildString {
                    append(parsed.homeOverall ?: 0); append(" : "); append(parsed.awayOverall ?: 0)
                },
                style = MaterialTheme.typography.titleLarge,
                color = colors.fg,
                fontWeight = FontWeight.Bold,
            )
        }
        Spacer(Modifier.height(2.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(awayTeam, style = MaterialTheme.typography.titleMedium, color = colors.fg, modifier = Modifier.weight(1f))
        }

        if (parsed.maps.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(1.dp)
                    .background(colors.hairline),
            )
            Spacer(Modifier.height(10.dp))
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                parsed.maps.forEach { m ->
                    val isCurrent = parsed.currentMap == m.map
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            "Map ${m.map}${if (isCurrent) "  ·  live" else ""}",
                            style = MaterialTheme.typography.labelMedium,
                            color = if (isCurrent) colors.live else colors.fgMuted,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            "${m.home} : ${m.away}",
                            style = MaterialTheme.typography.titleMedium,
                            color = if (isCurrent) colors.fg else colors.fgMuted,
                            fontWeight = if (m.winner != null) FontWeight.SemiBold else FontWeight.Normal,
                        )
                    }
                }
            }
        }
    }
}

