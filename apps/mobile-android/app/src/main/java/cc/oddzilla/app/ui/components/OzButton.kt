package cc.oddzilla.app.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import cc.oddzilla.app.ui.theme.OzTheme

// Pill-radius primary + ghost buttons mirroring the web `.btn` styles.
// Disabled state drops alpha to 0.5; the underlying click is gated on
// `enabled` so taps don't fall through.

private val PillShape = RoundedCornerShape(percent = 50)

@Composable
fun OzPrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val colors = OzTheme.colors
    val bg = if (enabled) colors.accent else colors.borderStrong
    val fg = colors.accentFg
    Box(
        modifier = modifier
            .height(44.dp)
            .clip(PillShape)
            .background(bg)
            .clickable(enabled = enabled, onClick = onClick)
            .alpha(if (enabled) 1f else 0.6f)
            .padding(horizontal = 20.dp),
        contentAlignment = Alignment.Center,
    ) {
        CompositionLocalProvider(LocalContentColor provides fg) {
            Text(text)
        }
    }
}

@Composable
fun OzGhostButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val colors = OzTheme.colors
    Box(
        modifier = modifier
            .height(40.dp)
            .clip(PillShape)
            .background(Color.Transparent)
            .border(BorderStroke(1.dp, colors.border), PillShape)
            .clickable(enabled = enabled, onClick = onClick)
            .alpha(if (enabled) 1f else 0.6f)
            .padding(horizontal = 18.dp),
        contentAlignment = Alignment.Center,
    ) {
        CompositionLocalProvider(LocalContentColor provides colors.fg) {
            Text(text)
        }
    }
}

@Suppress("unused")
private val ButtonContentPadding = PaddingValues(horizontal = 18.dp)
