// Canonical bettor-facing odds formatting.
//
// Oddin ships odds at up to 4 decimals, and a near-certain favorite in a
// live match is genuinely priced at something like 1.003. Rendering at a
// fixed 2dp therefore doesn't merely lose precision — it prints a price
// that does not exist: 1.003 becomes "1.00", which reads as "this bet
// returns exactly the stake" and is indistinguishable from a real
// 1.0000. (Observed on a live eBasketball match winner, 2026-08-27.)
//
// The rule: floor to 4 decimals, then trim trailing zeros down to a 2dp
// floor.
//     1.9100 -> "1.91"      1.0030 -> "1.003"
//     2.0000 -> "2.00"      1.9999 -> "1.9999"
//
// Floor (not round), with an epsilon in the scaled domain, matching the
// odds-publisher's big.Float scaled-to-Int convention: 1.003 is
// 1.0029999999999999 as a float64, so a bare truncation would emit
// "1.002". The 1e-6 epsilon lives in the *10000 domain — 1e-10 in raw
// odds, far below the NUMERIC(10,4) resolution the column stores, so it
// can never nudge a genuine value up to the next unit.
//
// Two server-side twins predate this module and run the same algorithm:
// `formatOdds` in services/api/src/modules/catalog/routes.ts (formats
// the API payload) and `formatOddsTrim` in
// services/api/src/lib/bettor-odds-adjustment.ts (formats the drift
// reference price the bet-delay worker compares against, and is mirrored
// again in Go). This module is what the storefront RENDERS through. If
// you change the algorithm here, change it in all of them — a divergence
// between the displayed price and the drift reference shows up as bets
// mysteriously rejected for odds drift.
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
 * Format a decimal odds value for display: up to 4dp, trailing zeros
 * trimmed to a 2dp minimum. Non-finite or negative input returns
 * ODDS_PLACEHOLDER rather than a fabricated number.
 */
export function formatOddsDisplay(n: number): string {
  if (!Number.isFinite(n)) return ODDS_PLACEHOLDER;
  const units = Math.floor(n * ODDS_SCALE + 1e-6);
  if (units < 0) return ODDS_PLACEHOLDER;
  const intPart = Math.floor(units / ODDS_SCALE);
  const frac = units % ODDS_SCALE;
  const padded = `${intPart}.${frac.toString().padStart(4, "0")}`;
  return padded.replace(/(\.\d{2})(\d*?)0+$/, "$1$2");
}
