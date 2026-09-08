/**
 * The market shapes a match LIST card may quote beyond the match winner.
 *
 * The Pro list layout carries fon.bet's three column groups — Result,
 * Handicap, Total — and Result is the only one the list endpoints used
 * to return. The other two are ladders: a match carries every rung from
 * -3.5 up, and a list row has space for exactly one. So two questions
 * have to be answered somewhere, and this is that somewhere:
 *
 *   1. WHICH market is "the handicap" / "the total" for a given feed.
 *   2. WHICH rung of it is the main line.
 *
 * (1) is a table, not a rule, for the same reason `bet-assist.ts` is a
 * table: `provider_market_id` is the feed's own market TYPE and there is
 * no shape that separates "match handicap" from "match ROUND handicap"
 * or "first half round handicap" — Oddin quotes all three, all keyed by
 * a lone `handicap` specifier. Every entry below was read off the live
 * catalogue on 2026-09-07, not inferred.
 *
 * (2) is a rule: the main line is the BALANCED one. That is what a main
 * line means in a book — the rung the two sides are nearest even on is
 * the one that trades — and it is derivable from data we already hold,
 * where the alternative is not: Fonbet flags its own main table
 * (`isMain`) but fonbet-ingester keeps that flag in memory and never
 * persists it, and Oddin sends no equivalent at all. Verified against
 * the live ladder for Getafe vs Celta: handicap picks `0` (1.70 / 2.17)
 * out of five rungs, total picks `1.5` (1.70 / 2.15) out of seven —
 * both the rung a trader would call the line.
 *
 * Import by subpath (`@oddzilla/types/list-markets`), never through the
 * barrel — apps/web pulls these in as VALUES; see the note in
 * `odds.ts`.
 */

export type LadderKind = "handicap" | "total";

export interface LadderMarketShape {
  /** The feed's market type id. */
  providerMarketId: number;
  /**
   * The ONLY specifier key a qualifying market may carry.
   *
   * This is the filter that keeps sub-events and per-map copies out. A
   * Fonbet corners handicap is `{variant: "fb:400100", handicap: "0"}`
   * and a CS2 map handicap is `{map: "1", handicap: "9.5"}`; the
   * full-match line is `{handicap: "-1"}` and nothing else. Requiring
   * an exact single-key match is stricter than listing keys to exclude,
   * and it stays right when a feed invents a new qualifier.
   */
  lineKey: "handicap" | "threshold";
  /**
   * Outcome ids in render order: [home, away] for a handicap,
   * [over, under] for a total.
   *
   * Ids, never names. The rendered name comes from the feed's localized
   * description template, so outside English a handicap's sides read
   * "Хозяева" / "Гости" and a comparison against the team name silently
   * treats every cell as home — the bug the match page's
   * `isAwayHandicapSide` documents at length.
   */
  outcomeIds: readonly [string, string];
  /**
   * The market TYPE as a readable kind ("od:2", "fb:304"). Since
   * migration 20260908T115542 a Fonbet provider_market_id is
   * registry-allocated and opaque, so `providerMarketId` below is only
   * meaningful for Oddin; a reader resolves the Fonbet shapes through
   * provider_market_types by this key.
   */
  marketKind: string;
}

/**
 * Handicap markets, by feed.
 *
 * Oddin `2` is the MATCH handicap, stated in maps for a series (a BO3
 * quoted at -1.5). Deliberately not `136` (match round handicap) or
 * `11` (per-map round handicap): those are round lines, they are not
 * what a card means by "handicap", and `11` carries a `map` specifier
 * so the single-key rule would drop it anyway.
 */
export const LADDER_HANDICAP_SHAPES: readonly LadderMarketShape[] = [
  { providerMarketId: 2, marketKind: "od:2", lineKey: "handicap", outcomeIds: ["1", "2"] },
  {
    providerMarketId: 1_000_304,
    marketKind: "fb:304",
    lineKey: "handicap",
    outcomeIds: ["h1", "h2"],
  },
];

/**
 * Total markets, by feed.
 *
 * Oddin `3` is "Number of maps" — the series total, which is the total
 * a CS2 card means (a BO3 at over/under 2.5 maps). Not `156` (match
 * total ROUNDS), whose numbers (61.5) would read as nonsense in a
 * column captioned "Total" beside a map handicap.
 *
 * Note Oddin's over/under ids are `5` / `4` — over first, and NOT in
 * numeric order.
 */
export const LADDER_TOTAL_SHAPES: readonly LadderMarketShape[] = [
  { providerMarketId: 3, marketKind: "od:3", lineKey: "threshold", outcomeIds: ["5", "4"] },
  {
    providerMarketId: 1_000_305,
    marketKind: "fb:305",
    lineKey: "threshold",
    outcomeIds: ["over", "under"],
  },
];

export function ladderShapesFor(kind: LadderKind): readonly LadderMarketShape[] {
  return kind === "handicap" ? LADDER_HANDICAP_SHAPES : LADDER_TOTAL_SHAPES;
}

/** Every provider market id either ladder kind can resolve to. */
export const LADDER_PROVIDER_MARKET_IDS: readonly number[] = [
  ...LADDER_HANDICAP_SHAPES,
  ...LADDER_TOTAL_SHAPES,
].map((s) => s.providerMarketId);

/**
 * Resolve a stored provider_market_id to its ladder shape.
 *
 * `kindOf` translates our registry ids, which are opaque (migration
 * 20260908T115542); the direct id comparison that follows still catches
 * Oddin's, whose id IS the market type. A caller with no registry to hand
 * passes nothing and gets the Oddin shapes only.
 */
export function ladderShapeByProviderMarketId(
  providerMarketId: number,
  kindOf?: (providerMarketId: number) => string | null,
): { kind: LadderKind; shape: LadderMarketShape } | null {
  const marketKind = kindOf?.(providerMarketId) ?? null;
  const hit = (shape: LadderMarketShape) =>
    shape.providerMarketId === providerMarketId ||
    (marketKind !== null && shape.marketKind === marketKind);
  for (const shape of LADDER_HANDICAP_SHAPES) {
    if (hit(shape)) return { kind: "handicap", shape };
  }
  for (const shape of LADDER_TOTAL_SHAPES) {
    if (hit(shape)) return { kind: "total", shape };
  }
  return null;
}

/** Every ladder market KIND, for resolving ids through the registry. */
export const LADDER_MARKET_KINDS: readonly string[] = [
  ...LADDER_HANDICAP_SHAPES,
  ...LADDER_TOTAL_SHAPES,
].map((s) => s.marketKind);

/**
 * Does this market's specifier set qualify it as a full-match ladder
 * rung? Exactly one key, and it is the line key.
 */
export function isFullMatchLadderMarket(
  specifiers: Record<string, string> | null | undefined,
  shape: LadderMarketShape,
): boolean {
  const keys = Object.keys(specifiers ?? {});
  return keys.length === 1 && keys[0] === shape.lineKey;
}

/** One rung of a ladder, as a main-line candidate. */
export interface LadderRung<T> {
  /** The line exactly as the feed states it: "-1.5", "2.5". */
  line: string;
  /** Decimal price of the first outcome (home / over), or null. */
  firstPrice: number | null;
  /** Decimal price of the second outcome (away / under), or null. */
  secondPrice: number | null;
  /** Whatever the caller needs handed back with the winner. */
  payload: T;
}

/**
 * Picks the main line: the rung whose two sides are nearest even money.
 *
 * Scored as `|o2 - o1| / (o1 + o2)` — the odds gap NORMALISED by the
 * pair's own level, which is the same thing as the implied-probability
 * gap normalised by the book's key:
 *
 *     |1/o1 - 1/o2| / (1/o1 + 1/o2)  ==  |o2 - o1| / (o1 + o2)
 *
 * The normalisation is the load-bearing half and the first cut of this
 * function did not have it. A raw gap — in odds OR in probability — is
 * scale-dependent, so it does not measure balance: on odds, 1.90/1.95
 * and 5.00/5.05 score identically; on probability, the LONGER pair
 * scores better (0.0020 against 0.0135), so a rung deep in the tail
 * could win the column by being far out rather than by being level.
 * The unit test that pinned the wrong expectation is what surfaced it.
 *
 * A rung needs both sides priced and bettable to qualify at all: a
 * half-priced rung cannot be scored for balance and cannot be rendered
 * as a pair either, so it is skipped rather than guessed at. Returns
 * null when no rung qualifies, which the caller renders as an empty
 * column — the same affordance a suspended price gets.
 *
 * Ties break toward the line closest to zero and then lexicographically,
 * so the answer is deterministic. Determinism matters more than which
 * way it breaks: an unstable pick would make the column flicker between
 * rungs on every poll.
 */
export function pickMainLine<T>(rungs: readonly LadderRung<T>[]): LadderRung<T> | null {
  let best: LadderRung<T> | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestAbs = Number.POSITIVE_INFINITY;
  for (const r of rungs) {
    if (r.firstPrice == null || r.secondPrice == null) continue;
    if (!(r.firstPrice > 1) || !(r.secondPrice > 1)) continue;
    const score =
      Math.abs(r.secondPrice - r.firstPrice) / (r.firstPrice + r.secondPrice);
    const abs = Math.abs(Number.parseFloat(r.line));
    const absCmp = Number.isFinite(abs) ? abs : Number.POSITIVE_INFINITY;
    if (
      score < bestScore ||
      (score === bestScore &&
        (absCmp < bestAbs ||
          (absCmp === bestAbs && best != null && r.line < best.line)))
    ) {
      best = r;
      bestScore = score;
      bestAbs = absCmp;
    }
  }
  return best;
}

/**
 * The line as one side plays it, with an explicit sign.
 *
 * The feed states a `handicap` from the HOME team's perspective, so a
 * home line of -1.5 means the away side is playing +1.5. `-0` coerces
 * to "0" in a template so it needs no special case.
 *
 * Shared with the match page's ladder cells (`handicapForSide` in
 * live-markets.tsx delegates here) because the sign is the part that
 * silently prints the wrong line for a whole column when it drifts —
 * which it did, on every Fonbet handicap, until 2026-09-07.
 */
export function handicapLineForSide(v: string | null, isAway: boolean): string {
  if (v == null) return "";
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return v;
  const side = isAway ? -n : n;
  return side > 0 ? `+${side}` : `${side}`;
}
