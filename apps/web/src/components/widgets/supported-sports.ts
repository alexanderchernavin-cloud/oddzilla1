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

export function supportsPrematchWidget(sportSlug: string | null | undefined): boolean {
  if (!sportSlug) return false;
  return PREMATCH_WIDGET_SPORTS.has(sportSlug.toLowerCase());
}

export function supportsLiveWidget(sportSlug: string | null | undefined): boolean {
  if (!sportSlug) return false;
  return LIVE_WIDGET_SPORTS.has(sportSlug.toLowerCase());
}
