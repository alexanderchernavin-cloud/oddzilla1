// Canonical bettor-facing odds formatting.
//
// Oddin ships odds at up to 4 decimals, and a near-certain favorite in a
// live match is genuinely priced at something like 1.003. Rendering at a
// fixed 2dp therefore doesn't merely lose precision — it prints a price
// that does not exist: 1.003 becomes "1.00", which reads as "this bet
// returns exactly the stake" and is indistinguishable from a real
// 1.0000. (Observed on a live eBasketball match winner, 2026-08-27.)
//
// That reasoning holds at one end of the range only, and until 2026-09-07
// it was applied across all of it — which is how a CS2 map winner reached
// the storefront as 5.1410 / 3.6860 / 1.1834. Nobody chose those digits
// and no book prints them. So the rule is now two steps: snap DOWN onto
// the quote ladder (see LADDER_BANDS — 0.01 up to 10, coarsening in the
// tail, and full precision kept below 1.01 where the ladder has nothing
// to say), then floor to 4 decimals and trim trailing zeros to a 2dp
// floor.
//     1.9100 -> "1.91"      1.0030 -> "1.003"
//     2.0000 -> "2.00"      1.9999 -> "1.99"
//     5.1410 -> "5.14"     23.7000 -> "23.50"
//
// Floor (not round), with an epsilon in the scaled domain, matching the
// odds-publisher's big.Float scaled-to-Int convention: 1.003 is
// 1.0029999999999999 as a float64, so a bare truncation would emit
// "1.002". The 1e-6 epsilon lives in the *10000 domain — 1e-10 in raw
// odds, far below the NUMERIC(10,4) resolution the column stores, so it
// can never nudge a genuine value up to the next unit.
//
// Five other places run the same algorithm, and a divergence between any
// of them shows up as bets mysteriously rejected for odds drift:
//   - services/odds-publisher formatPublishedOdds (Go) — the ONE that
//     matters most, because its string IS `market_outcomes.published_odds`
//     and therefore what every other layer reads;
//   - services/api catalog/routes.ts formatOdds (the API payload);
//   - services/api bettor-odds-adjustment.ts formatOddsTrimNum (the drift
//     reference the bet-delay worker compares against);
//   - services/ws-gateway bettor-adjustment.ts (live per-subscriber ticks);
//   - services/bet-delay adjust.go formatOddsTrim (the Go drift twin).
// The three TypeScript ones import `quoteOnLadder` from here; the two Go
// ones port it in the integer domain (see the note on ladderUnits there).
// This module is what the storefront RENDERS through.
//
// This file deliberately has NO imports: apps/web pulls it in as a VALUE
// via the `@oddzilla/types/odds` subpath, and the package is authored for
// NodeNext, so a relative `./x.js` import here would resolve under tsc
// but fail at `next build`.

const ODDS_SCALE = 10_000;

/** Em dash — what every caller renders when there's no usable price. */
export const ODDS_PLACEHOLDER = "—";

/**
 * Lowest decimal odds that can return a profit.
 *
 * Sub-1.01 prices are fully supported and bettable — Oddin quotes a
 * near-certain live favorite at e.g. 1.003, and that renders and places
 * normally. This is the floor at exactly 1.00, where a winning bet hands
 * back precisely the stake while still carrying full loss and void risk,
 * and below which (reachable the moment a non-zero `payback_margin_bp`
 * lands on any scope) a winning bet pays LESS than the stake.
 *
 * Such a price is DISPLAYED, not hidden — the cell just renders greyed
 * with an em dash the way a suspended outcome does. Mirrors the
 * `authNum <= 1` reject in POST /bets, so the UI never offers a price
 * placement would refuse. Oddin does not appear to send 1.00 in
 * practice; this is the defensive floor.
 */
export const MIN_BETTABLE_ODDS = 1;

/**
 * True when a price can actually return a profit, i.e. is worth
 * offering as a clickable cell. Null / non-finite / <= 1.00 are not.
 */
export function isBettableOdds(n: number | null | undefined): boolean {
  return n != null && Number.isFinite(n) && n > MIN_BETTABLE_ODDS;
}

/**
 * Lowest price the quote ladder can express.
 *
 * Below it the only rungs are 1.00, which is unbettable, and 1.01, which
 * is longer than the feed actually said — so prices under this floor keep
 * all four decimals. That is precisely the case the header note above is
 * about: Oddin genuinely quotes a near-certain live favorite at 1.003,
 * and both collapsing it to 1.00 and lengthening it to 1.01 print a price
 * that does not exist.
 */
export const LADDER_FLOOR = 1.01;

/**
 * The quote ladder: how coarse a price gets as it lengthens.
 *
 * The 4dp rule above was reasoned about at one end of the range and then
 * applied across all of it. Near 1.00 the extra digits are a real price.
 * At 5.1410 they are leaked arithmetic — no book prints that, and a
 * storefront that does reads as a machine showing its working. Same
 * complaint that put operator-authored prices on this ladder on
 * 2026-09-06; feed prices were left off it, so one book showed two
 * different kinds of number.
 *
 * Read as "up to `below`, step by `step`", first match wins. Two decimals
 * all the way to 10 covers the ordinary book; only the tail coarsens.
 *
 * Byte-identical to LADDER_BANDS in custom-events.ts, and DUPLICATED
 * rather than imported because both modules are pulled into apps/web as
 * values and must stay free of relative imports (see the header note).
 * `odds.test.ts` pins the two implementations against each other.
 */
const LADDER_BANDS: ReadonlyArray<{ below: number; step: number }> = [
  { below: 10, step: 0.01 },
  { below: 20, step: 0.1 },
  { below: 50, step: 0.5 },
  { below: 100, step: 1 },
  { below: Infinity, step: 5 },
];

/** The ladder step that applies at a given price. */
export function ladderStep(odds: number): number {
  for (const band of LADDER_BANDS) {
    if (odds < band.below) return band.step;
  }
  return 5;
}

/**
 * Snap a price DOWN onto the quote ladder.
 *
 * Floored, never rounded — the convention every other odds path here
 * follows, so a price only ever moves toward the house. The move is tiny
 * (5.141 -> 5.14 is four hundredths of a percent) and it is taken, not
 * lost.
 *
 * Returns 0 for non-finite or non-positive input; callers that need to
 * distinguish "no price" already guard for it before calling.
 */
export function quoteOnLadder(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n < LADDER_FLOOR) return floorToOddsDp(n);
  const step = ladderStep(n);
  // Work in integer multiples of the step so binary floating point can't
  // land a value a hair under its own rung — 7.57 / 0.01 is
  // 756.9999999999999, which would floor to 7.56.
  const rungs = Math.floor(n / step + 1e-9);
  // Back onto the 4dp storage grid: the 0.1 and 0.5 steps reintroduce the
  // usual float dust (73 * 0.1 = 7.300000000000001).
  return floorToOddsDp(rungs * step);
}

// Floor onto the 4dp grid, with the same scaled epsilon the formatter
// below uses. It is load-bearing on the sub-floor path: the publisher
// renders through big.Float, so a genuine 1.003 arrives as
// 1.0029999999999999 and a bare truncation would emit 1.0029 — the exact
// bug this module was written to prevent. custom-events.ts floors without
// it because its sub-floor values come from its own arithmetic and never
// carry that artefact.
function floorToOddsDp(value: number): number {
  return Math.floor(value * ODDS_SCALE + 1e-6) / ODDS_SCALE;
}

/**
 * Format a decimal odds value for display: snapped down onto the quote
 * ladder, then rendered at up to 4dp with trailing zeros trimmed to a 2dp
 * minimum. Non-finite or negative input returns ODDS_PLACEHOLDER rather
 * than a fabricated number.
 *
 * The ladder is idempotent, so this is a no-op on a price the publisher
 * already quoted onto it — it is applied here as well so no rendering
 * path can bypass it.
 */
export function formatOddsDisplay(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ODDS_PLACEHOLDER;
  const units = Math.floor(quoteOnLadder(n) * ODDS_SCALE + 1e-6);
  if (units < 0) return ODDS_PLACEHOLDER;
  const intPart = Math.floor(units / ODDS_SCALE);
  const frac = units % ODDS_SCALE;
  const padded = `${intPart}.${frac.toString().padStart(4, "0")}`;
  return padded.replace(/(\.\d{2})(\d*?)0+$/, "$1$2");
}
