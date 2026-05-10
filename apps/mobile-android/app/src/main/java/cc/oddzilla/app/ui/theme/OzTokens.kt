package cc.oddzilla.app.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.graphics.Color

// Material3 ColorScheme covers Material's slot vocabulary (primary,
// surface, onBackground, …). Oddzilla's design system has extra roles
// — positive/negative deltas, live red, tier gold, hairlines, sunken
// surfaces, sport accents — so we ship a sibling palette through a
// CompositionLocal and read it via `OzTheme.colors` from any composable.

@Immutable
data class OzColors(
    val bg: Color,
    val bgElevated: Color,
    val bgSunken: Color,
    val surface: Color,
    val surface2: Color,
    val border: Color,
    val borderStrong: Color,
    val hairline: Color,
    val fg: Color,
    val fgMuted: Color,
    val fgDim: Color,
    val fgInverse: Color,
    val accent: Color,
    val accentFg: Color,
    val positive: Color,
    val negative: Color,
    val live: Color,
    val tierGold: Color,
    val sportCs2: Color = OzSportCs2,
    val sportLol: Color = OzSportLol,
    val sportDota: Color = OzSportDota,
    val sportValorant: Color = OzSportValorant,
    val sportRl: Color = OzSportRl,
    val sportOw: Color = OzSportOw,
    val sportSc: Color = OzSportSc,
)

val LightOzColors = OzColors(
    bg = OzLightBg,
    bgElevated = OzLightBgElevated,
    bgSunken = OzLightBgSunken,
    surface = OzLightSurface,
    surface2 = OzLightSurface2,
    border = OzLightBorder,
    borderStrong = OzLightBorderStrong,
    hairline = OzLightHairline,
    fg = OzLightFg,
    fgMuted = OzLightFgMuted,
    fgDim = OzLightFgDim,
    fgInverse = OzLightFgInverse,
    accent = OzLightAccent,
    accentFg = OzLightAccentFg,
    positive = OzLightPositive,
    negative = OzLightNegative,
    live = OzLightLive,
    tierGold = OzLightTierGold,
)

val DarkOzColors = OzColors(
    bg = OzDarkBg,
    bgElevated = OzDarkBgElevated,
    bgSunken = OzDarkBgSunken,
    surface = OzDarkSurface,
    surface2 = OzDarkSurface2,
    border = OzDarkBorder,
    borderStrong = OzDarkBorderStrong,
    hairline = OzDarkHairline,
    fg = OzDarkFg,
    fgMuted = OzDarkFgMuted,
    fgDim = OzDarkFgDim,
    fgInverse = OzDarkFgInverse,
    accent = OzDarkAccent,
    accentFg = OzDarkAccentFg,
    positive = OzDarkPositive,
    negative = OzDarkNegative,
    live = OzDarkLive,
    tierGold = OzDarkTierGold,
)

val LocalOzColors = compositionLocalOf<OzColors> {
    error("OzColors not provided — wrap content in OddzillaTheme.")
}

object OzTheme {
    val colors: OzColors
        @androidx.compose.runtime.Composable
        @androidx.compose.runtime.ReadOnlyComposable
        get() = LocalOzColors.current
}
