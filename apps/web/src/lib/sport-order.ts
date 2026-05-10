// Sport-ordering helpers. The flagship esports (CS2, Dota 2, LoL,
// Valorant) are pinned to the top of every list / chip row / sidebar;
// everything else falls back to alphabetical. Bot leagues are hidden
// defensively across the storefront — they're also filtered out at
// the feed-ingester level, but a defence in depth here means a stale
// /catalog response or admin re-enable never leaks them into the UI.
//
// CLAUDE.md flags this list as load-bearing — keep the slugs in
// lockstep with the feed-ingester BLOCKED_ODDIN_SPORT_SLUGS default.

export const TOP_SPORT_SLUGS = ["cs2", "dota2", "lol", "valorant"] as const;
export const HIDDEN_SPORT_SLUGS = new Set<string>([
  "efootballbots",
  "ebasketballbots",
]);

// Lower is more important. Returns TOP_SPORT_SLUGS.length for any slug
// not in the pinned list — the sort then falls through to a secondary
// criterion (usually `name.localeCompare`).
export function sportRank(slug: string): number {
  const i = (TOP_SPORT_SLUGS as readonly string[]).indexOf(slug);
  return i === -1 ? TOP_SPORT_SLUGS.length : i;
}

// Short display names for the most-truncated chrome spots
// (top-bar chips, narrow sidebar widths). Anything not listed
// falls back to the full sport name.
export function shortName(name: string): string {
  if (name === "Counter-Strike 2") return "CS2";
  if (name === "League of Legends") return "LoL";
  if (name === "Dota 2") return "Dota 2";
  if (name === "Rocket League") return "RL";
  return name;
}

// Order a list of `{slug, name, ...}` rows by pinned-first then
// alphabetical. Bot leagues are filtered out.
export function orderSportsForChips<T extends { slug: string; name: string }>(
  items: T[],
): T[] {
  const visible = items.filter((s) => !HIDDEN_SPORT_SLUGS.has(s.slug));
  return [...visible].sort((a, b) => {
    const ra = sportRank(a.slug);
    const rb = sportRank(b.slug);
    if (ra !== rb) return ra - rb;
    if (ra === TOP_SPORT_SLUGS.length) return a.name.localeCompare(b.name);
    return 0;
  });
}

// Order a list of match rows (carrying a `sport.slug` + `sport.name`)
// by their sport's rank, then alphabetical within the non-pinned tail.
// Stable on equal ranks so callers can pre-sort by a secondary key
// (e.g. scheduled_at) and have it preserved within each sport group.
export function orderMatchesBySport<
  T extends { sport: { slug: string; name: string } },
>(items: T[]): T[] {
  const visible = items.filter((m) => !HIDDEN_SPORT_SLUGS.has(m.sport.slug));
  return [...visible].sort((a, b) => {
    const ra = sportRank(a.sport.slug);
    const rb = sportRank(b.sport.slug);
    if (ra !== rb) return ra - rb;
    if (ra === TOP_SPORT_SLUGS.length) {
      const byName = a.sport.name.localeCompare(b.sport.name);
      if (byName !== 0) return byName;
    }
    return 0;
  });
}
