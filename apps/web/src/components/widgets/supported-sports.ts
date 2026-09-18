// Sport-slug allowlists for Oddin Disir widgets, mirrored from the
// "Supported Esports and eSimulators" table in the integration docs.
// Used by the storefront to skip rendering the widget shell for
// sports Disir wouldn't return data for — keeps the UI from showing a
// loading skeleton that resolves to "not available".
//
// Slugs come from the seed (cs2, dota2, lol, valorant) and from
// auto-mapper output (efootball, ebasketball, ecricket).

export const PREMATCH_WIDGET_SPORTS = new Set<string>([
  "cs2",
  "dota2",
  "lol",
  "valorant",
  "efootball",
]);

export const LIVE_WIDGET_SPORTS = new Set<string>([
  "cs2",
  "dota2",
  "lol",
  "valorant",
  "efootball",
  "ebasketball",
  "ecricket",
]);

// Master kill switch for the Disir storefront widgets (2026-09-18).
// Turned OFF because Disir exposes no live widget for our sports — the only
// live standalone widget, `scoreboard`, returns no data for CS2 (and the
// rest 403), so the live slot only ever showed "Live stats not available",
// while the prematch stats hub worked. Rather than ship a half-working set,
// all Disir surfaces are hidden for now: the three mounts (rail Insights
// tab, mobile prematch panel, live-stats block) all gate on the two
// functions below, so returning false here removes every Disir surface
// without touching the mounts — the video stream and the non-Disir Analyses
// tab are unaffected, and no Bifrost fallback fires (the widgets never
// mount). Restore by flipping this to true; the api routes, proxy env, DNS
// and cert all stay in place, so nothing else needs changing.
// Typed as boolean (not narrowed to the literal) so the guards below read
// as ordinary runtime checks and flip cleanly.
const DISIR_WIDGETS_ENABLED: boolean = false;

export function supportsPrematchWidget(sportSlug: string | null | undefined): boolean {
  if (!DISIR_WIDGETS_ENABLED) return false;
  if (!sportSlug) return false;
  return PREMATCH_WIDGET_SPORTS.has(sportSlug.toLowerCase());
}

export function supportsLiveWidget(sportSlug: string | null | undefined): boolean {
  if (!DISIR_WIDGETS_ENABLED) return false;
  if (!sportSlug) return false;
  return LIVE_WIDGET_SPORTS.has(sportSlug.toLowerCase());
}
