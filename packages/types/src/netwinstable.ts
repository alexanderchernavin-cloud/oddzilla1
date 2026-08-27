// Netwinstable Key Adjustment (Betradar) — see
// HumanDocs/"Documentation - Algorithm Netwinstable Key Adjustment - client.docx".
//
// Given the current odds set (which already carries some book-margin
// "key", expressed as Σ 1/odds_i in [0..N]) and a desired new key, find
// the odds set that:
//
//   1. Sums to the new key (Σ 1/odds'_i = keyTarget), AND
//   2. Preserves the netwin ratio between every pair of outcomes:
//      (odds'_i - 1) / (odds'_j - 1) = (odds_i - 1) / (odds_j - 1).
//
// Condition (2) is equivalent to saying there exists a single scalar α
// such that odds'_i = 1 + α · (odds_i - 1). Substituting into (1) gives
// one equation in one unknown:
//
//   f(α) = Σ 1 / (1 + α · (odds_i - 1)) - keyTarget = 0
//
// f is strictly monotonically decreasing in α on (0, ∞):
//   - α → 0:  every odds'_i → 1, so f → N - keyTarget (positive).
//   - α → ∞:  every odds'_i → ∞, so f → -keyTarget (negative).
//
// Bisection is therefore guaranteed to converge for any keyTarget in
// (0, N), with N the number of outcomes. This is the same shape the
// doc describes for the 2-outcome and 3-outcome closed forms; we use
// the numeric solver here because ZillaFlash markets are arbitrary
// outcome counts (e.g. CS2 map totals, eFootball 1X2, map handicaps).
//
// Returns the adjusted odds in the same order as the input. NaN/non-finite
// inputs are passed through unchanged so a partial market doesn't blow
// up the offer (caller should drop those outcomes upstream).

/**
 * Compute the "book key" = sum of inverse odds. A 2-outcome book at
 * 1.95 / 1.95 has key 1.0256 (≈2.56% margin); fair would be 1.0.
 */
export function bookKey(odds: ReadonlyArray<number>): number {
  let s = 0;
  for (const o of odds) {
    if (Number.isFinite(o) && o > 1) s += 1 / o;
  }
  return s;
}

/**
 * Apply the Netwinstable Key Adjustment.
 *
 * @param oddsOriginal — current displayed odds for every outcome of the
 *   market. Must all be > 1; non-finite values are returned as-is.
 * @param keyTarget — desired Σ 1/odds. Must lie in (0, N) where N is the
 *   number of valid outcomes; otherwise returns oddsOriginal unchanged.
 * @returns adjusted odds in the same order. The function is pure.
 */
export function applyNetwinstableKey(
  oddsOriginal: ReadonlyArray<number>,
  keyTarget: number,
): number[] {
  const n = oddsOriginal.length;
  if (n === 0) return [];

  // Capture indices of valid (>1, finite) outcomes; everything else
  // passes through. Netwinstable only makes sense over the active set.
  const idx: number[] = [];
  const orig: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = oddsOriginal[i];
    if (Number.isFinite(o) && (o as number) > 1) {
      idx.push(i);
      orig.push(o as number);
    }
  }

  const m = orig.length;
  if (m === 0) return [...oddsOriginal];
  if (!Number.isFinite(keyTarget) || keyTarget <= 0 || keyTarget >= m) {
    // Target outside the achievable band — return original to fail safe.
    return [...oddsOriginal];
  }

  // Bisect α in (0, ∞). Anchor the bracket at α=1 (= original odds).
  // If the original key already equals the target, α=1 is the solution.
  const c = orig.map((o) => o - 1);

  const keyAt = (alpha: number): number => {
    let s = 0;
    for (const ci of c) s += 1 / (1 + alpha * ci);
    return s;
  };

  const keyOrig = keyAt(1);
  if (Math.abs(keyOrig - keyTarget) < 1e-9) return [...oddsOriginal];

  // f(α) = keyAt(α) - keyTarget is strictly decreasing.
  // f(0) = m - keyTarget > 0 (since keyTarget < m).
  // f(∞) = -keyTarget < 0.
  // Walk to find an α with f(α) and f(1) of opposite sign.
  let lo: number;
  let hi: number;
  if (keyOrig > keyTarget) {
    // Need a higher α (smaller key).
    lo = 1;
    hi = 2;
    while (keyAt(hi) > keyTarget && hi < 1e9) hi *= 2;
  } else {
    // Need a lower α (larger key).
    hi = 1;
    lo = 0.5;
    while (keyAt(lo) < keyTarget && lo > 1e-9) lo *= 0.5;
  }

  // ~50 iters of bisection puts us at ≈1e-15 of the root for any
  // realistic bracket — well below display precision (4 decimals).
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    const k = keyAt(mid);
    if (k > keyTarget) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-12) break;
  }
  const alpha = 0.5 * (lo + hi);

  const out = [...oddsOriginal];
  for (let i = 0; i < idx.length; i++) {
    out[idx[i]!] = 1 + alpha * c[i]!;
  }
  return out;
}

/**
 * ZillaFlash-specific helper: lower the current market key by
 * `keyDeltaPct` percentage points (e.g. 3 → reduce the key by 3pp).
 * Used at offer-creation time and on every live-odds refresh so the
 * displayed boost reflects the latest underlying odds.
 *
 * Returns the adjusted odds for every outcome of the market AND
 * convenience lookups for the specific outcome being boosted.
 */
export interface NetwinstableBoostResult {
  /** Adjusted odds in input order. */
  adjustedOdds: number[];
  /** keyOriginal - keyAdjusted, expressed as a fraction (e.g. 0.03 = 3pp). */
  effectiveKeyDelta: number;
  /** Σ 1/odds_i before adjustment. */
  keyOriginal: number;
  /** Σ 1/odds'_i after adjustment. */
  keyAdjusted: number;
}

/**
 * Ceiling on how much of a SINGLE outcome's own implied probability one
 * selection boost may shave, as a fraction of that probability.
 *
 * The fair-book clamp alone is not enough for per-selection boosts. It
 * bounds the whole market's key, but a market's headroom (key - 1.0) can
 * easily exceed a longshot's entire implied probability: a 3-way book at
 * key 1.05 with one outcome at 20.00 (p = 0.05) has 0.05 of headroom, so
 * an unclamped 5pp boost on that leg would drive its probability to zero
 * and its price to infinity. Capping the shave at half the outcome's own
 * probability bounds any boosted selection at 2x its raw price, which is
 * far past any realistic promo while making a fat-fingered percentage
 * impossible to turn into free money.
 */
export const SELECTION_BOOST_MAX_PROB_SHARE = 0.5;

export interface NetwinstableSelectionBoostResult {
  /** Adjusted odds in input order; unboosted outcomes are unchanged. */
  adjustedOdds: number[];
  /** Key delta actually applied per index, as a fraction. 0 = untouched. */
  effectiveDeltas: number[];
  /** Sum of effectiveDeltas. 0 means the whole call was a no-op. */
  effectiveKeyDelta: number;
  keyOriginal: number;
  keyAdjusted: number;
}

/**
 * Per-selection boost: shave `keyDeltaPctByIndex[i]` percentage points of
 * key off outcome i alone, leaving its siblings at their raw price.
 *
 * This is the single-cell counterpart to boostMarketKey. Where the market
 * variant spreads one key delta across the whole outcome set (preserving
 * netwin ratios, so every cell moves), this one takes the delta entirely
 * out of the boosted outcome's own implied probability:
 *
 *     1/odds'_i = 1/odds_i - delta_i
 *
 * Two clamps bound the result, both order-independent so the client's
 * live recompute and the api's placement re-validation agree exactly:
 *
 *   1. Per outcome — never shave more than SELECTION_BOOST_MAX_PROB_SHARE
 *      of that outcome's own probability.
 *   2. Across the market — the sum of the applied deltas can never take
 *      the book key to 1.0 (fair). When several selections in one market
 *      are boosted and their combined request exceeds the available
 *      headroom, every delta is scaled by the same factor rather than
 *      letting whichever one is evaluated first consume it all.
 *
 * Outcomes at exactly 1.00 (or non-finite) are skipped, matching
 * bookKey / applyNetwinstableKey — they carry no key to give back.
 */
export function boostSelectionKeys(
  oddsOriginal: ReadonlyArray<number>,
  keyDeltaPctByIndex: ReadonlyArray<number>,
): NetwinstableSelectionBoostResult {
  const n = oddsOriginal.length;
  const adjustedOdds = [...oddsOriginal];
  const effectiveDeltas = new Array<number>(n).fill(0);
  const keyOriginal = bookKey(oddsOriginal);
  const noop = (): NetwinstableSelectionBoostResult => ({
    adjustedOdds,
    effectiveDeltas,
    effectiveKeyDelta: 0,
    keyOriginal,
    keyAdjusted: keyOriginal,
  });

  const headroom = keyOriginal - 1.0;
  if (!(headroom > 0)) return noop();

  const caps = new Array<number>(n).fill(0);
  let totalRequested = 0;
  for (let i = 0; i < n; i++) {
    const o = oddsOriginal[i];
    const pct = keyDeltaPctByIndex[i] ?? 0;
    if (!Number.isFinite(o) || (o as number) <= 1) continue;
    if (!Number.isFinite(pct) || pct <= 0) continue;
    const cap = Math.min(
      pct / 100,
      (1 / (o as number)) * SELECTION_BOOST_MAX_PROB_SHARE,
    );
    if (!(cap > 0)) continue;
    caps[i] = cap;
    totalRequested += cap;
  }
  if (!(totalRequested > 0)) return noop();

  const scale = totalRequested > headroom ? headroom / totalRequested : 1;
  let applied = 0;
  for (let i = 0; i < n; i++) {
    const cap = caps[i]!;
    if (cap <= 0) continue;
    const delta = cap * scale;
    const p = 1 / (oddsOriginal[i] as number) - delta;
    // Unreachable given clamp (1) — kept so a future clamp change can
    // only produce a no-op, never a negative-probability price.
    if (!(delta > 0) || !(p > 0)) continue;
    adjustedOdds[i] = 1 / p;
    effectiveDeltas[i] = delta;
    applied += delta;
  }
  if (!(applied > 0)) return noop();

  return {
    adjustedOdds,
    effectiveDeltas,
    effectiveKeyDelta: applied,
    keyOriginal,
    keyAdjusted: keyOriginal - applied,
  };
}

export function boostMarketKey(
  oddsOriginal: ReadonlyArray<number>,
  keyDeltaPct: number,
): NetwinstableBoostResult {
  const keyOriginal = bookKey(oddsOriginal);
  // Clamp target ≥ 1.0 so we never give the player a fair-or-better book
  // by accident (would be a real-money exploit). If the upstream book is
  // already at or below 1.0 there's nothing to give back; emit a no-op
  // result so the caller can drop the offer cleanly.
  const requested = keyOriginal - keyDeltaPct / 100;
  const keyTarget = Math.max(requested, 1.0);
  if (keyOriginal <= 1.0 || keyTarget >= keyOriginal) {
    return {
      adjustedOdds: [...oddsOriginal],
      effectiveKeyDelta: 0,
      keyOriginal,
      keyAdjusted: keyOriginal,
    };
  }
  const adjustedOdds = applyNetwinstableKey(oddsOriginal, keyTarget);
  return {
    adjustedOdds,
    effectiveKeyDelta: keyOriginal - keyTarget,
    keyOriginal,
    keyAdjusted: keyTarget,
  };
}

// ── ZillaBoost pricing (Custom Boosted Odds, migration 0085+) ────────
// The ONE place a market's boosted cells are computed. Three callers
// must agree to the last decimal or a bettor's click 400s on the
// ±CUSTOM_BOOST_PLACEMENT_TOLERANCE drift check:
//   - the match page, recomputing on every WS tick (realtime prices),
//   - GET /catalog/zillaboost-banners, quoting server-side per poll,
//   - POST /bets, re-validating the leg before it debits stake.
// They all route through quoteMarketBoost rather than re-deriving the
// rules, clamps, and drop conditions locally.
//
// This lives here rather than in boosted-odds.ts (where the rest of the
// ZillaBoost wire types are) because apps/web imports it as a VALUE:
// the package is authored for NodeNext, so a relative `./netwinstable.js`
// import from boosted-odds.ts resolves fine under tsc but fails at
// `next build` — webpack won't map the `.js` suffix onto the `.ts` file.
// Keeping the math and its formatter in one import-free module sidesteps
// that entirely.

/**
 * Canonical formatting for boosted prices — floor to 2 decimals, the
 * same quoting shape ZillaFlash uses. MUST stay byte-identical between
 * the client (live recompute from WS ticks) and the api (placement
 * re-validation): both sides format through this one function so the
 * ±0.01 placement tolerance only ever absorbs real tick drift, never
 * formatting skew.
 */
export function formatBoostedOdds(n: number): string {
  if (!Number.isFinite(n)) return "0.00";
  return (Math.floor(n * 100) / 100).toFixed(2);
}

/**
 * The priced-outcome predicate every boost caller shares.
 *
 * `>= 1`, not `> 1`: a live favorite ticking through 1.00 must stay in
 * the set. Dropping it left the market with a single priced outcome and
 * flickered the whole market's boost off and on with each tick; the
 * helpers above already handle an outcome at exactly 1.00 (it carries
 * no key, so it simply doesn't move).
 */
export function isQuotableOutcomeOdds(odds: number): boolean {
  return Number.isFinite(odds) && odds >= 1;
}

/** One priced, active outcome of the market being quoted. */
export interface BoostQuoteOutcome {
  outcomeId: string;
  publishedOdds: number;
}

/** The rule fields pricing needs — scope has already been resolved. */
export interface BoostQuoteRule {
  ruleId: string;
  boostPct: number;
  endsAt: string | null;
}

/** One boosted cell of the market, ready to render or validate. */
export interface BoostQuoteCell {
  outcomeId: string;
  ruleId: string;
  boostPct: number;
  endsAt: string | null;
  originalOdds: string;
  boostedOdds: string;
}

/**
 * Price one market's boosted cells.
 *
 * `outcomes` must already be filtered to the priced, active set — see
 * isQuotableOutcomeOdds for the exact predicate every caller shares.
 *
 * Precedence: when `selections` is non-empty the market is priced by
 * SELECTION boosts only and `marketWide` is ignored for it. Composing
 * the two would double-dip — the market-wide pass already takes the key
 * to its fair-book floor, and a selection delta on top of that would
 * push the book past fair, which is real money out the door. Cells
 * without their own selection rule therefore keep their raw price.
 *
 * Returns [] when nothing is boosted, when the fair-book clamp leaves
 * no headroom, or when the boost is invisible at display precision (a
 * crossed-out "1.95 -> 1.95" reads as a bug, not a promo).
 */
export function quoteMarketBoost(args: {
  outcomes: readonly BoostQuoteOutcome[];
  marketWide: BoostQuoteRule | null;
  /** outcomeId -> rule, for outcome-scope rules on this market. */
  selections?: ReadonlyMap<string, BoostQuoteRule> | null;
}): BoostQuoteCell[] {
  const { outcomes, marketWide } = args;
  const selections = args.selections ?? null;

  if (selections && selections.size > 0) {
    const deltas = outcomes.map(
      (o) => selections.get(o.outcomeId)?.boostPct ?? 0,
    );
    const adjusted = boostSelectionKeys(
      outcomes.map((o) => o.publishedOdds),
      deltas,
    );
    if (adjusted.effectiveKeyDelta <= 0) return [];
    const cells: BoostQuoteCell[] = [];
    outcomes.forEach((o, i) => {
      const rule = selections.get(o.outcomeId);
      if (!rule || adjusted.effectiveDeltas[i]! <= 0) return;
      const originalOdds = formatBoostedOdds(o.publishedOdds);
      const boostedOdds = formatBoostedOdds(adjusted.adjustedOdds[i]!);
      // Per-cell drop: only this cell wears the boost, so if its price
      // didn't move at display precision there is nothing to show.
      // (The market-wide branch below drops the whole market instead —
      // there the boost belongs to the market, and hiding it on just
      // the favorite made one side look unboosted and flicker.)
      if (boostedOdds === originalOdds) return;
      cells.push({
        outcomeId: o.outcomeId,
        ruleId: rule.ruleId,
        boostPct: rule.boostPct,
        endsAt: rule.endsAt,
        originalOdds,
        boostedOdds,
      });
    });
    return cells;
  }

  if (!marketWide) return [];
  if (outcomes.length < 2) return [];
  const adjusted = boostMarketKey(
    outcomes.map((o) => o.publishedOdds),
    marketWide.boostPct,
  );
  if (adjusted.effectiveKeyDelta <= 0) return [];
  const cells = outcomes.map((o, i) => ({
    outcomeId: o.outcomeId,
    ruleId: marketWide.ruleId,
    boostPct: marketWide.boostPct,
    endsAt: marketWide.endsAt,
    originalOdds: formatBoostedOdds(o.publishedOdds),
    boostedOdds: formatBoostedOdds(adjusted.adjustedOdds[i]!),
  }));
  if (cells.every((c) => c.boostedOdds === c.originalOdds)) return [];
  return cells;
}
