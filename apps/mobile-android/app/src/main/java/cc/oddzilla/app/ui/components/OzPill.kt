package cc.oddzilla.app.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import cc.oddzilla.app.ui.theme.OzTheme

// Small chip used for filters, status badges, sport accents. Variant
// controls the fill — `accent` flips fg/bg for active state, `outline`
// is the resting state.

enum class OzPillVariant { Outline, Filled }

@Composable
fun OzPill(
    text: String,
    modifier: Modifier = Modifier,
    variant: OzPillVariant = OzPillVariant.Outline,
    accentColor: Color? = null,
) {
    val colors = OzTheme.colors
    val (bg, fg, border) = when (variant) {
        OzPillVariant.Outline -> Triple(Color.Transparent, accentColor ?: colors.fg, colors.border)
        OzPillVariant.Filled -> Triple(accentColor ?: colors.accent, colors.accentFg, Color.Transparent)
    }
    val shape = RoundedCornerShape(percent = 50)
    Box(
        modifier = modifier
            .clip(shape)
            .background(bg)
            .border(BorderStroke(1.dp, border), shape)
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text(text, style = MaterialTheme.typography.labelMedium, color = fg)
    }
}
