package cc.oddzilla.app.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val LightScheme = lightColorScheme(
    primary = OzLightAccent,
    onPrimary = OzLightAccentFg,
    secondary = OzLightFg,
    onSecondary = OzLightAccentFg,
    background = OzLightBg,
    onBackground = OzLightFg,
    surface = OzLightSurface,
    onSurface = OzLightFg,
    surfaceVariant = OzLightSurface2,
    onSurfaceVariant = OzLightFgMuted,
    outline = OzLightBorder,
    outlineVariant = OzLightHairline,
    error = OzLightNegative,
    onError = OzLightAccentFg,
)

private val DarkScheme = darkColorScheme(
    primary = OzDarkAccent,
    onPrimary = OzDarkAccentFg,
    secondary = OzDarkFg,
    onSecondary = OzDarkAccentFg,
    background = OzDarkBg,
    onBackground = OzDarkFg,
    surface = OzDarkSurface,
    onSurface = OzDarkFg,
    surfaceVariant = OzDarkSurface2,
    onSurfaceVariant = OzDarkFgMuted,
    outline = OzDarkBorder,
    outlineVariant = OzDarkHairline,
    error = OzDarkNegative,
    onError = OzDarkAccentFg,
)

@Composable
fun OddzillaTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colorScheme = if (darkTheme) DarkScheme else LightScheme
    val ozColors = if (darkTheme) DarkOzColors else LightOzColors

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = colorScheme.background.toArgb()
            window.navigationBarColor = colorScheme.background.toArgb()
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !darkTheme
                isAppearanceLightNavigationBars = !darkTheme
            }
        }
    }

    CompositionLocalProvider(LocalOzColors provides ozColors) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = OzTypography,
            content = content,
        )
    }
}
