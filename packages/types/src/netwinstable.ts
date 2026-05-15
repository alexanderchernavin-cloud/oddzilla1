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
