package cc.oddzilla.app.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import cc.oddzilla.app.ui.theme.OzTheme

// Outline-card variant used everywhere on the web shell. Surface fill,
// 1dp border, 14dp radius. Inset padding is the caller's choice.

@Composable
fun OzCard(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val colors = OzTheme.colors
    val shape = RoundedCornerShape(14.dp)
    Box(
        modifier = modifier
            .clip(shape)
            .background(colors.surface)
            .border(BorderStroke(1.dp, colors.border), shape),
    ) {
        content()
    }
}
