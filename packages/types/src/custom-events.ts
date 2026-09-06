// Custom events — operator-authored markets that come from no feed.
//
// Everything here is pure arithmetic, shared by the API (which writes the
// prices) and the backoffice (which previews them live while an operator
// types). Keeping one implementation is the point: a preview that
// disagreed with what the save wrote would be worse than no preview.
//
// Import by subpath (`@oddzilla/types/custom-events`), never through the
// barrel — see the note on packages/types/src/odds.ts.

/**
 * `provider_market_id` every custom market carries.
 *
 * One shared id rather than one per market, because this column is a
 * market TYPE everywhere else in the system: `riskzilla_market_factors`
 * keys a risk multiplier off it, `fe_market_display_order` orders tabs by
 * it, and the ZillaBoost allowlist filters on it. A per-market id would
 * make every one of those per-market, which is unusable. Custom markets
 * are told apart inside a match by their `custom` specifier instead.
 *
 * It sits above Fonbet's 1 000 000 base so the three namespaces never
 * overlap: Oddin small ints, Fonbet 1 000 000+, custom 2 000 000.
 */
export const CUSTOM_PROVIDER_MARKET_ID = 2_000_000;

/** URN prefixes. Deliberately 9 characters like `od:match:` / `fb:match:`. */
export const CUSTOM_MATCH_URN_PREFIX = "cu:match:";
export const CUSTOM_SPORT_SLUG = "custom";

/**
 * The specifier key that distinguishes two custom markets on one event.
 *
 * `(match_id, provider_market_id, specifiers_hash)` is a market's
 * identity, so with a shared provider_market_id the specifier is what
 * makes a second market on the same event possible at all.
 */
export const CUSTOM_SPECIFIER_KEY = "custom";

/**
 * Probability floor. Bounds the published price at 1 / 0.0001 = 10 000,
 * which still fits NUMERIC(10,4), and stops a rounding path from ever
 * producing a divide-by-zero.
 */
export const MIN_CUSTOM_PROBABILITY = 0.0001;

/** Odds are stored NUMERIC(10,4); everything here rounds to that grid. */
const ODDS_DP = 4;

export interface CustomOutcomeInput {
  outcomeId: string;
  /** The operator's own view of this outcome's chance, in (0, 1). */
  baseProbability: number;
  /**
   * What the book already owes if this outcome wins, in micro units.
   * Read only when liability trading is on. Absent or 0 means no money
   * is on this outcome yet.
   */
  exposureMicro?: number;
}

export interface LiabilityTradingConfig {
  enabled: boolean;
  /**
   * How far to move toward the money, in basis points of the way there.
   * 0 = ignore bets entirely, 10 000 = price purely off the money.
   */
  strengthBp: number;
  /**
   * Hard cap on how far one outcome's probability may move from the
   * operator's base, in basis points of absolute probability.
   */
  maxShiftBp: number;
}

export interface CustomPriceCell {
  outcomeId: string;
  /** Normalised base probability — what the operator believes. */
  baseProbability: number;
  /** Probability actually priced. Equals `baseProbability` when trading is off. */
  probability: number;
  /** Fair odds at `probability`, before the overround. */
  rawOdds: number;
  /** The bettor-facing price. */
  publishedOdds: number;
  /** Signed move applied by liability trading, in basis points. */
  shiftBp: number;
}

function roundDown(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.floor(value * f) / f;
}

/**
 * Price one custom market.
 *
 * Three steps, in this order:
 *
 *  1. **Normalise** the operator's probabilities so they sum to 1. They
 *     are entered by hand and will not sum exactly; normalising rather
 *     than rejecting means an operator can type 60 / 30 / 20 and get a
 *     sane book instead of an error.
 *
 *  2. **Trade the liability**, when enabled. Each outcome's share of the
 *     book's current exposure is blended into its probability:
 *     `p = (1 - k)·base + k·moneyShare`. Both inputs sum to 1, so the
 *     blend does too and needs no second normalisation. The direction is
 *     the whole point — money arriving on an outcome RAISES its assigned
 *     probability, which SHORTENS its price, so the book stops selling
 *     value where it is already exposed and starts offering it on the
 *     other side. A book pulled level that way earns its overround
 *     whatever happens, which is what "maximise the winnings" means for a
 *     bookmaker: not picking winners, but being indifferent to them.
 *
 *     `maxShiftBp` caps how far any one outcome may travel from the
 *     operator's view, so a single large bet cannot walk the price off a
 *     cliff. The clamp breaks the sum, so the result is renormalised —
 *     which can carry a value slightly back past its cap. The cap is
 *     therefore a close bound, not an exact one, and it is documented as
 *     such rather than iterated to a fixed point: an operator setting
 *     "at most 15%" wants a leash, not a guarantee to seven decimals.
 *
 *  3. **Apply the overround.** `published = 1 / (p · (1 + overround))`,
 *     so the book key `Σ(1/published)` comes out at exactly `1 + overround`.
 *     Prices are rounded DOWN to the 4dp storage grid: down shortens the
 *     price, which is the house-safe direction, and it matches the floor
 *     `formatOddsDisplay` already applies on the way to the screen.
 *
 * Returns cells in input order. Throws on fewer than two outcomes or a
 * non-finite / non-positive base probability — both are operator input
 * errors the caller should surface, not silently repair.
 */
export function priceCustomMarket(params: {
  outcomes: CustomOutcomeInput[];
  overroundBp: number;
  liability?: LiabilityTradingConfig | null;
}): CustomPriceCell[] {
  const { outcomes, overroundBp } = params;
  if (outcomes.length < 2) {
    throw new Error("a market needs at least two outcomes");
  }
  for (const o of outcomes) {
    if (!Number.isFinite(o.baseProbability) || o.baseProbability <= 0) {
      throw new Error(`outcome ${o.outcomeId} needs a probability above zero`);
    }
  }

  const baseSum = outcomes.reduce((a, o) => a + o.baseProbability, 0);
  const base = outcomes.map((o) => o.baseProbability / baseSum);

  let priced = base;
  const liability = params.liability;
  if (liability?.enabled && liability.strengthBp > 0) {
    const exposure = outcomes.map((o) => Math.max(0, o.exposureMicro ?? 0));
    const exposureSum = exposure.reduce((a, v) => a + v, 0);
    if (exposureSum > 0) {
      const k = clamp(liability.strengthBp / 10_000, 0, 1);
      const cap = Math.max(0, liability.maxShiftBp) / 10_000;
      const blended = base.map((b, i) => {
        const moneyShare = exposure[i]! / exposureSum;
        const t = (1 - k) * b + k * moneyShare;
        const capped = cap > 0 ? clamp(t, b - cap, b + cap) : t;
        return Math.max(capped, MIN_CUSTOM_PROBABILITY);
      });
      const blendedSum = blended.reduce((a, v) => a + v, 0);
      priced = blended.map((v) => v / blendedSum);
    }
  }

  const overround = 1 + Math.max(0, overroundBp) / 10_000;
  return outcomes.map((o, i) => {
    const p = Math.max(priced[i]!, MIN_CUSTOM_PROBABILITY);
    const b = base[i]!;
    return {
      outcomeId: o.outcomeId,
      baseProbability: b,
      probability: p,
      rawOdds: roundDown(1 / p, ODDS_DP),
      publishedOdds: roundDown(1 / (p * overround), ODDS_DP),
      shiftBp: Math.round((p - b) * 10_000),
    };
  });
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * The book key a set of prices implies: `Σ(1/odds)`. 1.0 is a fair book,
 * 1.05 a 5% overround. Shown in the backoffice so an operator can see the
 * margin they actually shipped rather than the one they asked for —
 * rounding each price down to the storage grid nudges the real key a
 * little above the requested one.
 */
export function bookKey(publishedOdds: number[]): number {
  return publishedOdds.reduce((a, o) => (o > 0 ? a + 1 / o : a), 0);
}
