// How the Sportradar embeds follow the storefront's light/dark theme.
//
// All four embeds (tracker, Head to Head, Live Table, Bet Assist) frame
// Sportradar's hosted standalone page, which forwards `wl-` prefixed hash
// keys into the widgetloader's options — and the loader takes a `theme`
// there. Only from a FIXED list, though, which it validates against (read
// from `/betradar/widgetloader`, 2026-09-06): `<client>`, `<client>dark`,
// `<client>transparent` and `<client>darktransparent` for the two public
// clients (`betradar`, `sportradar`), plus `default`, `neutral` and `mx`.
// Each name resolves to a stylesheet at
// `https://widgets.sir.sportradar.com/<name>/css`; an unknown name is
// dropped silently and the client's own theme loads instead.
//
// Two of those are dark, and they are not interchangeable. Both were
// rendered on a #1a1a1c backdrop before choosing (2026-09-06; tracker,
// Head to Head, Bet Assist and the live table):
//   - `betradardark` paints every base tile Sportradar blue (#0072b1). It
//     is a branded dark look, and on our near-black surfaces it reads as
//     a blue box dropped onto the page.
//   - `betradardarktransparent` sets the base tile transparent and the
//     text light, so the widget takes whatever is behind it — and since
//     the hosted page's own body is transparent too, "behind it" is OUR
//     iframe's background. The widget sits on the same surface as the
//     cards around it.
//
// The loader reads `theme` ONCE, when its script initialises. A later
// `hashchange` re-parses the hash into the options object, but the theme
// has already been resolved, so changing only the hash leaves the old
// stylesheet in place. That is why every embed keys its iframe on the
// theme: a toggle remounts the frame, and the new document boots with the
// new theme. (The tracker's expand/collapse still rides the hash alone, as
// before — that one the widget re-reads live.)
//
// A dark user's frame therefore mounts once with the light URL during
// hydration — useDocumentTheme reports "light" until its effect runs, so
// SSR and the first client render agree — and is replaced a tick later.
// The discarded document has fetched at most the 4 KB page and the start
// of the loader, and has painted nothing. What the bettor sees from the
// first frame is the iframe's own background, which is why that is a CSS
// token (`--sportradar-frame-bg`, set per theme in globals.css) rather
// than a value picked in JS: the pre-hydration boot script sets
// `data-theme` before first paint, so the frame is dark from the start
// instead of flashing white until hydration catches up.
//
// Light sends no `wl-theme` at all and is byte-identical to before: the
// client's default theme (`betradar`) loads exactly as it always has.

import type { DocumentTheme } from "@/lib/use-theme";

/** Sportradar's theme name the embeds use while the storefront is dark. */
export const SPORTRADAR_DARK_THEME = "betradardarktransparent";

/**
 * Hash parts (`key=value`) to append to a standalone-page URL so the widget
 * follows the given storefront theme. Empty for light — see the header.
 */
export function sportradarThemeHashParts(
  theme: DocumentTheme | undefined,
): string[] {
  return theme === "dark" ? [`wl-theme=${SPORTRADAR_DARK_THEME}`] : [];
}

/**
 * Background every Sportradar iframe paints. The hosted page's body is
 * transparent, so this is what shows through wherever the widget paints
 * nothing: white in light, doubling as the light widgets' own body colour,
 * and the dark surface in dark, where the transparent theme paints no base
 * of its own and this IS the widget's surface.
 */
export const SPORTRADAR_FRAME_BACKGROUND = "var(--sportradar-frame-bg)";
