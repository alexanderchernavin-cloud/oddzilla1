// Tiple + Tippot product math.
//
// CRITICAL: the Go implementation at
//   services/api/...?  no — we keep the math here in TS for the bet
//   placement path, and duplicate it in Go for settlement. Both must
//   agree byte-for-byte against docs/fixtures/products.json. Tests run
//   on both sides against the same fixture.
//
// Float64 is fine: we cap N at 12 for tippot (well within float resolution
// for our domain) and floor-truncate to a fixed decimal scale at the end,
// which absorbs ULP-level discrepancies.
//
// Math summary:
//
//   Tiple (at-least-one wins):
//     P_any = 1 − ∏(1 − pᵢ)
//     offered = 1 / (P_any × (1 + margin_bp/10000))
//     floor-truncate to 2 decimals (matches published_odds convention).
//
//   Tippot (tiered by # of winners):
//     Compute the Poisson-Binomial PMF over (p₁..pₙ).
//     P(≥k) = Σⱼ≥ₖ PMF(j)
//     tier_offered_k = (1/N) × 1/P(≥k) / (1 + margin_bp/10000)
//     M_j (cumulative payout multiplier for finishing with j wins)
//          = Σₖ₌₁ⱼ tier_offered_k
//     M_j is strictly increasing. Floor-truncate each M_j to 4 decimals.

const TIPLE_DECIMALS = 2;
const TIPPOT_DECIMALS = 4;

/** Floor-truncate `x` to `decimals` decimal places, return as fixed-precision string. */
function floorToDecimalsString(x: number, decimals: number): string {
  if (!Number.isFinite(x) || x < 0) return (0).toFixed(decimals);
  const scale = Math.pow(10, decimals);
  const scaled = Math.floor(x * scale);
  return (scaled / scale).toFixed(decimals);
}

/** Parse a decimal probability string into a [0,1] float; throws on invalid. */
export function parseProbability(s: string): number {
  if (typeof s !== "string" || s.length === 0) {
    throw new Error("probability is empty");
  }
  const f = Number(s);
  if (!Number.isFinite(f) || f < 0 || f > 1) {
    throw new Error(`probability out of range: ${s}`);
  }
  return f;
}

// ─── Tiple ─────────────────────────────────────────────────────────────

export interface TipleQuote {
  /** Decimal-string offered odds shown to the user, e.g. "1.42". */
  offeredOdds: string;
  /** Implied "any-of-N wins" probability — useful for analytics. */
  fairProbability: number;
  /** Margin in basis points used. */
  marginBp: number;
  /** N = number of legs. */
  n: number;
}

/**
 * Price a Tiple ticket. `probabilities` is the per-leg implied probability,
 * float in [0, 1]. Returns the offered decimal odds and the fair "any wins"
 * probability for audit.
 *
 * Throws if any probability is 1 (would force fair_prob = 1.0 and div-by-0
 * after margin) or if the list is empty / has < 2 entries.
 */
export function priceTiple(probabilities: number[], marginBp: number): TipleQuote {
  const n = probabilities.length;
  if (n < 2) throw new Error(`tiple needs ≥ 2 legs, got ${n}`);
  // Effective margin (caller-computed: base + per-leg × N from
  // bet_product_config). 200000 bp = 2000% — well above any realistic
  // admin config but bounded as a sanity guard against div-by-near-zero.
  if (marginBp < 0 || marginBp > 200000) {
    throw new Error(`margin_bp out of range: ${marginBp}`);
  }
  for (const p of probabilities) {
    if (!(p > 0 && p < 1)) {
      throw new Error(`tiple needs each prob in (0,1), got ${p}`);
    }
  }
  // P_any = 1 - product(1 - pi). Multiply in given order.
  let prodLose = 1;
  for (const p of probabilities) {
    prodLose = prodLose * (1 - p);
  }
  const fairProb = 1 - prodLose;
  if (fairProb <= 0) {
    throw new Error("tiple fair probability is 0 — degenerate input");
  }
  // offered = 1 / (P_any * (1 + m))
  const divisor = (1 + marginBp / 10000);
  const fairOdds = 1 / fairProb;
  const offered = fairOdds / divisor;
  return {
    offeredOdds: floorToDecimalsString(offered, TIPLE_DECIMALS),
    fairProbability: fairProb,
    marginBp,
    n,
  };
}

// ─── Tippot ────────────────────────────────────────────────────────────

export interface TippotTier {
  /** Number of winning legs (1..N). */
  k: number;
  /**
   * Probability of getting AT LEAST k correct, decimal string with 6
   * decimals (recorded for audit, not used at settlement).
   */
  pAtLeastK: string;
  /**
   * Cumulative payout multiplier for finishing with exactly k wins.
   * stake × multiplier = payout. Decimal string, 4 decimals, floor-truncated.
   * Strictly increasing in k.
   */
  multiplier: string;
}

export interface TippotQuote {
  marginBp: number;
  n: number;
  tiers: TippotTier[];
}

/**
 * Price a Tippot ticket. Returns the full per-tier multiplier schedule.
 * Bettors who place a Tippot at this quote receive `stake × tiers[j-1].multiplier`
 * if they finish with j winning legs (j ≥ 1). j = 0 → ticket lost.
 *
 * The pricing is provably margin-bounded: E[payout] / stake = 1/(1+margin_bp/10000)
 * exactly — see the per-tier sub-bet decomposition note in the migration.
 */
export function priceTippot(probabilities: number[], marginBp: number): TippotQuote {
  const n = probabilities.length;
  if (n < 2) throw new Error(`tippot needs ≥ 2 legs, got ${n}`);
  // Effective margin (caller-computed: base + per-leg × N from
  // bet_product_config). 200000 bp = 2000% — well above any realistic
  // admin config but bounded as a sanity guard against div-by-near-zero.
  if (marginBp < 0 || marginBp > 200000) {
    throw new Error(`margin_bp out of range: ${marginBp}`);
  }
  for (const p of probabilities) {
    if (!(p > 0 && p < 1)) {
      throw new Error(`tippot needs each prob in (0,1), got ${p}`);
    }
  }

  // Poisson-Binomial PMF via the standard convolution DP.
  // pmf[k] = probability of exactly k successes after processing legs[0..i].
  let pmf: number[] = new Array(n + 1).fill(0);
  pmf[0] = 1;
  for (let i = 0; i < n; i++) {
    const p = probabilities[i]!;
    const next: number[] = new Array(n + 1).fill(0);
    // Recurrence: next[k] = pmf[k] * (1 - p) + pmf[k-1] * p
    // Compute in ascending k so we can read pmf[k-1] before overwriting.
    for (let k = 0; k <= i + 1; k++) {
      const stayLose = k <= i ? pmf[k]! * (1 - p) : 0;
      const gainWin = k > 0 ? pmf[k - 1]! * p : 0;
      next[k] = stayLose + gainWin;
    }
    pmf = next;
  }

  // P(>=k) computed by suffix sum, descending so floating addition order
  // is identical between TS and Go (Go does the same).
  const pAtLeast = new Array(n + 2).fill(0);
  for (let k = n; k >= 1; k--) {
    pAtLeast[k] = pAtLeast[k + 1] + pmf[k]!;
  }

  // Per-tier offered price: (1/N) × 1/P(>=k) × 1/(1+m).
  // Cumulative multiplier: M_j = sum k=1..j of tier_offered_k.
  const divisor = 1 + marginBp / 10000;
  const tiers: TippotTier[] = [];
  let cumulative = 0;
  for (let k = 1; k <= n; k++) {
    const pk = pAtLeast[k]!;
    if (pk <= 0) {
      // Theoretically impossible since each p ∈ (0,1), but guard anyway —
      // would mean impossible-to-get-k-correct, division by zero ahead.
      throw new Error(`tippot tier ${k} is unreachable (P(>=${k}) = ${pk})`);
    }
    const tierOffered = ((1 / n) / pk) / divisor;
    cumulative = cumulative + tierOffered;
    tiers.push({
      k,
      pAtLeastK: pk.toFixed(6),
      multiplier: floorToDecimalsString(cumulative, TIPPOT_DECIMALS),
    });
  }

  return { marginBp, n, tiers };
}

// ─── Wire shape stored on tickets.bet_meta ─────────────────────────────

/** What gets serialized into tickets.bet_meta for tiple. */
export interface TipleMeta {
  product: "tiple";
  n: number;
  marginBp: number;
  fairProbability: string; // 6 decimals
}

/** What gets serialized into tickets.bet_meta for tippot. */
export interface TippotMeta {
  product: "tippot";
  n: number;
  marginBp: number;
  tiers: TippotTier[];
}

export type BetMeta = TipleMeta | TippotMeta;
