# res/font/

Drop the brand TTFs here, then swap the `FontFamily` references in
[`ui/theme/Type.kt`](../../../../java/cc/oddzilla/app/ui/theme/Type.kt)
from `FontFamily.SansSerif` / `FontFamily.Serif` / `FontFamily.Monospace`
to the bundled families.

## Files to add (filenames matter — Compose Resources is case-sensitive
on most devices and Android's font naming convention is snake_case):

```
res/font/
├── geist_regular.ttf
├── geist_medium.ttf
├── geist_semibold.ttf
├── geist_bold.ttf
├── geist_mono_medium.ttf
└── instrument_serif_regular.ttf
```

## Theme wiring

In `ui/theme/Type.kt`:

```kotlin
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import cc.oddzilla.app.R

private val Geist = FontFamily(
    Font(R.font.geist_regular, FontWeight.Normal),
    Font(R.font.geist_medium, FontWeight.Medium),
    Font(R.font.geist_semibold, FontWeight.SemiBold),
    Font(R.font.geist_bold, FontWeight.Bold),
)
private val GeistMono = FontFamily(Font(R.font.geist_mono_medium, FontWeight.Medium))
private val InstrumentSerif = FontFamily(Font(R.font.instrument_serif_regular, FontWeight.Normal))

private val Sans = Geist
private val Serif = InstrumentSerif
private val Mono = GeistMono
```

Until those files are present, `Type.kt` falls back to the system
`SansSerif` / `Serif` / `Monospace` families. The layout looks
identical in metrics — only the typeface changes when you bundle the
real TTFs.

## Licensing

- **Geist** — open source under the SIL Open Font License (Vercel).
  Download the TTF set from https://vercel.com/font.
- **Instrument Serif** — Google Fonts, SIL OFL.
  Download from https://fonts.google.com/specimen/Instrument+Serif.

Make sure the licence files (OFL.txt) are committed alongside the TTFs.
