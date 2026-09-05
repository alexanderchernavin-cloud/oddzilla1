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

// Fallback allowlist for the lobby's Top sports strip, used ONLY while
// no sport carries an operator pin. It is the pre-0103 hard-coded list
// and exists so a fresh estate shows something sensible rather than an
// empty strip.
//
// The strip is operator-controlled now: pin sports on /admin/sports and
// they become Top sports, in that order. That replaced a seven-slug esports
// allowlist nobody could change without a deploy — the operator asked
// for real top sports, which on a line carrying Fonbet means Football
// and Basketball can lead, not just CS2 and Dota.
export const LOBBY_CHIP_SPORT_SLUGS = [
  "cs2",
  "dota2",
  "lol",
  "valorant",
  "cs2-duels",
  "dota2-duels",
  "efootball",
] as const;

// Top sports for the lobby strip.
//
// Operator pins win: any sport with a `display_order` is a Top sport, in
// pin order. Only when NOTHING is pinned does this fall back to the
// hard-coded slug list, so the lobby is never empty on an estate that
// has not been configured yet.
//
// Hidden bot slugs are dropped in both paths — a pin on one would
// otherwise resurrect it here after every other surface filtered it out.
export function filterSportsForLobbyChips<
  T extends { slug: string } & Pinnable,
>(items: T[]): T[] {
  const visible = items.filter((s) => !HIDDEN_SPORT_SLUGS.has(s.slug));
  const pinned = visible.filter((s) => s.displayOrder != null);
  if (pinned.length > 0) {
    return [...pinned].sort(
      (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0),
    );
  }
  const order = LOBBY_CHIP_SPORT_SLUGS as readonly string[];
  const rank = new Map(order.map((s, i) => [s, i] as const));
  return visible
    .filter((s) => rank.has(s.slug))
    .sort((a, b) => rank.get(a.slug)! - rank.get(b.slug)!);
}

// Lower is more important. Returns TOP_SPORT_SLUGS.length for any slug
// not in the pinned list — the sort then falls through to a secondary
// criterion (usually `name.localeCompare`).
export function sportRank(slug: string): number {
  const i = (TOP_SPORT_SLUGS as readonly string[]).indexOf(slug);
  return i === -1 ? TOP_SPORT_SLUGS.length : i;
}

// An operator pin position from /admin/sports (migration 0103). Absent
// on every row until somebody pins something, which is why every helper
// here takes it as optional rather than required — a caller whose type
// predates the column still compiles and still sorts the old way.
interface Pinnable {
  displayOrder?: number | null;
}

// MAX_SAFE_INTEGER for an unpinned row puts it after every pinned one
// when sorting ASC — the same "NULLS LAST" shape the SQL side uses for
// this column and the tournament tier sort already uses for risk_tier.
function pinPosition(row: Pinnable): number {
  return row.displayOrder ?? Number.MAX_SAFE_INTEGER;
}

// The one place the storefront decides which sport comes first.
//
// Three tiers, in order: the operator's pinned sequence, then the
// hard-coded flagship slugs, then the name. The pin tier is what
// /admin/sports writes; the two below it are the rule that governed
// everything before it existed, so an estate with nothing pinned sorts
// exactly as it always did.
//
// Deliberately NOT the bettor's own saved order — that one wins over
// all three and is applied by `orderSportsForSidebar`, because an
// operator setting a default must not overwrite a choice a bettor made.
export function compareSports<T extends { slug: string; name: string } & Pinnable>(
  a: T,
  b: T,
): number {
  const pa = pinPosition(a);
  const pb = pinPosition(b);
  if (pa !== pb) return pa - pb;
  const ra = sportRank(a.slug);
  const rb = sportRank(b.slug);
  if (ra !== rb) return ra - rb;
  return a.name.localeCompare(b.name);
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

// Order a list of `{slug, name, ...}` rows by operator pin, then
// flagship slug, then alphabetically. Bot leagues are filtered out.
export function orderSportsForChips<
  T extends { slug: string; name: string } & Pinnable,
>(items: T[]): T[] {
  const visible = items.filter((s) => !HIDDEN_SPORT_SLUGS.has(s.slug));
  return [...visible].sort(compareSports);
}

// Build a normalised Set of slugs the bettor has hidden (migration
// 0072). Accepts null / empty / unset for callers that pass the user
// prop straight through. Never includes globally-hidden bot slugs
// because those are filtered out unconditionally elsewhere.
export function hiddenSportsSet(userHidden: string[] | null | undefined): Set<string> {
  if (!userHidden || userHidden.length === 0) return new Set();
  return new Set(userHidden);
}

// Order a list of `{slug, name, ...}` rows using the bettor's
// customised sport-order preference. Sports present in `userOrder` are
// placed first in the user's chosen sequence; anything missing
// (newly-added sport, slug typo in the saved array, etc.) falls back
// to the default ordering and is appended after. Hidden bot slugs are
// dropped, matching `orderSportsForChips`.
//
// `userOrder = null` short-circuits to the default order so callers
// can pass the user prop through unconditionally.
//
// `userHidden` slugs are dropped entirely from the returned list. The
// sidebar's edit mode uses `partitionSportsForEdit` instead so the
// bettor can still see + un-hide them; everywhere else the hidden set
// is filtered out by this helper.
export function orderSportsForSidebar<
  T extends { slug: string; name: string } & Pinnable,
>(
  items: T[],
  userOrder: string[] | null,
  userHidden: string[] | null = null,
): T[] {
  const hidden = hiddenSportsSet(userHidden);
  const visible = items.filter(
    (s) => !HIDDEN_SPORT_SLUGS.has(s.slug) && !hidden.has(s.slug),
  );
  if (!userOrder || userOrder.length === 0) {
    return orderSportsForChips(visible);
  }
  const bySlug = new Map(visible.map((s) => [s.slug, s] as const));
  const placed = new Set<string>();
  const head: T[] = [];
  for (const slug of userOrder) {
    if (placed.has(slug)) continue;
    const hit = bySlug.get(slug);
    if (hit) {
      head.push(hit);
      placed.add(slug);
    }
  }
  const tail = orderSportsForChips(
    visible.filter((s) => !placed.has(s.slug)),
  );
  return [...head, ...tail];
}

// Sidebar edit-mode layout: returns two ordered lists — visible sports
// in the bettor's chosen order, followed by hidden sports (so the
// bettor can un-hide them). Both lists strip the global bot slugs.
// Within the hidden bucket we sort the default way (pinned-first then
// alphabetical) so the bettor isn't asked to remember the order they
// hid things in.
export function partitionSportsForEdit<
  T extends { slug: string; name: string } & Pinnable,
>(
  items: T[],
  userOrder: string[] | null,
  userHidden: string[] | null,
): { visible: T[]; hidden: T[] } {
  const hidden = hiddenSportsSet(userHidden);
  const notHidden = items.filter(
    (s) => !HIDDEN_SPORT_SLUGS.has(s.slug) && !hidden.has(s.slug),
  );
  const isHidden = items.filter(
    (s) => !HIDDEN_SPORT_SLUGS.has(s.slug) && hidden.has(s.slug),
  );
  // Re-use the same ordering machinery as the live sidebar so the
  // edit-mode arrangement matches what the user sees outside edit
  // mode (minus the hidden tail).
  const orderedVisible = orderSportsForSidebar(notHidden, userOrder, null);
  const orderedHidden = orderSportsForChips(isHidden);
  return { visible: orderedVisible, hidden: orderedHidden };
}

// Order a list of match rows (carrying a `sport.slug` + `sport.name`)
// by their sport's rank, then alphabetical within the non-pinned tail.
// Stable on equal ranks so callers can pre-sort by a secondary key
// (e.g. scheduled_at) and have it preserved within each sport group.
// Hidden sports (global bot slugs + the bettor's hidden_sports) are
// dropped — callers don't need to filter separately.
export function orderMatchesBySport<
  T extends { sport: { slug: string; name: string } & Pinnable },
>(items: T[], userHidden: string[] | null = null): T[] {
  const hidden = hiddenSportsSet(userHidden);
  const visible = items.filter(
    (m) => !HIDDEN_SPORT_SLUGS.has(m.sport.slug) && !hidden.has(m.sport.slug),
  );
  // Same three tiers the rail uses, read off each row's own sport —
  // /catalog/matches carries `sport.displayOrder` per match precisely so
  // these cross-sport lists don't have to fetch the sports tree.
  return [...visible].sort((a, b) => compareSports(a.sport, b.sport));
}
