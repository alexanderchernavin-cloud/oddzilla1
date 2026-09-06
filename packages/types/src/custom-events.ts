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

/** Odds are stored NUMERIC(10,4); the fair-odds column keeps that grid. */
const ODDS_DP = 4;

/**
 * What to call a custom event.
 *
 * `matches` stores two sides because every fixture has two, and both
 * columns are NOT NULL. A question has one subject — "Dima and Nastya to
 * unite again" — so a markets-layout event puts its whole title in
 * `home_team` and leaves `away_team` EMPTY. That empty string is the
 * convention this reads, and it is deliberately a property of the ROW
 * rather than a lookup into `custom_event_config`: the bet slip, bet
 * history and community tickets all carry the two team strings and
 * nothing else, so a rule they can apply without a second fetch is the
 * only one that reaches every surface.
 *
 * Never renders a dangling "vs".
 */
export function formatEventTitle(
  homeTeam: string,
  awayTeam: string | null | undefined,
): string {
  const away = (awayTeam ?? "").trim();
  return away.length === 0 ? homeTeam : `${homeTeam} vs ${away}`;
}

/**
 * Lowest price the quote ladder can express.
 *
 * Below it the only two-decimal values are 1.00, which is unbettable, and
 * 1.01, which is longer than the model said — so prices under this floor
 * keep their full precision instead.
 */
export const LADDER_FLOOR = 1.01;

/**
 * The quote ladder: how coarse a price gets as it lengthens.
 *
 * A fixed 0.01 step is right near evens and absurd in the tail — it
 * quoted a longshot at **90.90**, a hundredth of precision on a price
 * nobody reads to the hundredth and no book prints. The step has to grow
 * with the number.
 *
 * Read as "up to `below`, step by `step`", first match wins. The bands
 * keep every price an operator has already seen: two decimals all the way
 * to 10 covers the ordinary book, and only the tail coarsens.
 *
 * Deliberately gentler than an exchange ladder, which would quantise 7.57
 * to 7.4. Nothing was wrong with 7.57 — the complaint was about the tail,
 * so that is what moved.
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
  return LADDER_BANDS[LADDER_BANDS.length - 1]!.step;
}

/**
 * Quote an authored price onto the ladder.
 *
 * Feed prices keep four decimals because Oddin genuinely quotes a
 * near-certain favorite at 1.003, and rounding that to 1.00 prints a
 * price that does not exist. **We are not a feed here.** These prices are
 * derived from a probability an operator typed, so four decimals is
 * precision nobody entered and no book quotes: a market came out at
 * 4.7619 / 1.1904 on the storefront, which reads as a machine leaking its
 * arithmetic.
 *
 * The step widens with the price — see `LADDER_BANDS`. A flat hundredth
 * is right near evens and ridiculous in the tail, where it produced
 * **90.90**.
 *
 * Floor, not round, so a price only ever moves toward the house — the
 * convention every other odds path here follows. The cost is that the
 * delivered book key sits a little above the requested overround; that is
 * margin taken, not margin lost, and the backoffice shows the real key.
 * The cost is bounded in the direction that matters: a coarse step high
 * up moves a tiny slice of the book (1/90 against 1/90.9 is four
 * ten-thousandths of key), while the fine step sits exactly where the
 * probability mass is.
 *
 * Under `LADDER_FLOOR` the ladder cannot represent the value at all, so
 * those keep four decimals. That is the same case
 * `packages/types/src/odds.ts` exists for, and it is reachable here: a
 * 99.5% probability prices at 1.005, which the ladder would either kill
 * (1.00) or lengthen (1.01).
 */
export function quoteOnLadder(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n < LADDER_FLOOR) return roundDown(n, ODDS_DP);
  const step = ladderStep(n);
  // Work in integer multiples of the step to keep binary floating point
  // from landing a value a hair under its own rung — 7.57 / 0.01 is
  // 756.9999999999999, which would floor to 7.56.
  const rungs = Math.floor(n / step + 1e-9);
  // Back onto the 4dp storage grid: 0.1 and 0.5 steps reintroduce the
  // usual float dust (73 * 0.1 = 7.300000000000001).
  return roundDown(rungs * step, ODDS_DP);
}

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
 *  3. **Apply the overround**, then quote onto the ladder.
 *     `published = 1 / (p · (1 + overround))` puts the book key
 *     `Σ(1/published)` at exactly `1 + overround`, and `quoteOnLadder`
 *     then floors each price to two decimals — see its own note for why
 *     an authored price is not quoted like a feed price. Flooring takes
 *     a little more margin than asked for, so the delivered key sits
 *     slightly above `1 + overround`; the backoffice shows the real one.
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
      // Fair odds keep full precision — they are the model's own value,
      // never quoted to a bettor. Only the published price goes on the
      // ladder.
      rawOdds: roundDown(1 / p, ODDS_DP),
      publishedOdds: quoteOnLadder(1 / (p * overround)),
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
