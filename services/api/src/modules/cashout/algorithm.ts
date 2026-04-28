// Cashout algorithm — pure functions, no IO. Mirrors chapter 2 of
// /Cashout/Cashout_Function_201119.pdf. Three modes:
//
//   1. Simple Cashout (chapter 2.1.1)
//        offer = stake × ticketOdds × Π(legProb)
//      For settled-won legs we substitute prob=1 and odds=1 (the leg
//      drops out). Settled-void legs collapse the leg's odds out of the
//      product entirely. Settled-lost legs collapse the offer to 0.
//
//   2. Cashout with additional expected profit (chapter 2.1.2)
//        offer = simpleOffer / deductionFactor
//      where deductionFactor is interpolated from a ladder of
//      (currentValue/stake → factor) tuples.
//
//   3. Prematch full-stake window (Oddzilla extension)
//      Within N seconds of placement, while the match has not yet
//      started, the offer is set to the stake. Industry convention for
//      "cancel as cashout".
//
// Money is BIGINT micro_usdt throughout. Floating point appears only in
// the probability/odds product (those are decimal strings from the feed
// and we accept some precision loss there); the final offer is rounded
// down to the nearest micro and then capped at potentialPayout so we
// never offer more than the win.

import type { CashoutLadderStep, CashoutUnavailableReason } from "@oddzilla/types";

export interface LegInput {
  /** Decimal odds at placement (the price the user got). */
  oddsAtPlacement: string;
  /**
   * Current decimal probability of this leg winning. null if the
   * outcome row has no probability (will fall back to 1/oddsCurrent
   * inside the engine).
   */
  probabilityCurrent: number | null;
  /**
   * 1/oddsCurrent fallback. Only used when probabilityCurrent is null.
   * The fair probability without margin would be 1/odds; we accept the
   * baked-in margin here because Oddin already includes it. See
   * Sportradar §2.2 — this is the documented poor-man's substitute.
   */
  oddsCurrent: string | null;
  /** Whether the outcome / market is currently active. */
  active: boolean;
  /**
   * Settlement state for this leg, if any. Otherwise null.
   *  - "won":  drops out of the product (prob=1, oddsContrib=1)
   *  - "lost": collapses offer to 0
   *  - "void": drops out, leg's odds are removed from ticketOdds
   *  - "half_won" / "half_lost": treated as fractional contribution.
   */
  result: "won" | "lost" | "void" | "half_won" | "half_lost" | null;
  voidFactor: string | null;
}

export interface ComputeInput {
  betType: "single" | "combo" | "system";
  stakeMicro: bigint;
  potentialPayoutMicro: bigint;
  placedAtMs: number;
  matchEarliestKickoffMs: number | null; // null = unknown / already in play
  legs: LegInput[];
  config: {
    enabled: boolean;
    prematchFullPaybackSeconds: number;
    deductionLadder: CashoutLadderStep[] | null;
    minOfferMicro: bigint;
    minValueChangeBp: number; // gates "significant change"
  };
  nowMs: number;
}

export interface ComputeOutput {
  available: boolean;
  reason?: CashoutUnavailableReason;
  offerMicro: bigint;
  ticketOdds: number;
  probability: number;
  ticketValueFairMicro: bigint;
  deductionFactor: number | null;
  fullPayback: boolean;
}

export function compute(input: ComputeInput): ComputeOutput {
  if (!input.config.enabled) {
    return blank("feature_disabled");
  }

  // Check for prematch full-stake window first. If we're inside the
  // window AND every leg's match hasn't started, return stake. This
  // bypasses the rest of the math.
  const fullPaybackWindow =
    input.config.prematchFullPaybackSeconds > 0 &&
    input.nowMs - input.placedAtMs <= input.config.prematchFullPaybackSeconds * 1000 &&
    input.matchEarliestKickoffMs !== null &&
    input.matchEarliestKickoffMs > input.nowMs;

  let ticketOdds = 1;
  let probability = 1;

  for (const leg of input.legs) {
    if (leg.result === "lost") {
      return blank("leg_lost", { ticketOdds, probability });
    }

    // Voided legs: full void = leg drops out completely (odds and prob
    // both = 1). Half-voided not yet supported — treat like full void.
    if (leg.result === "void" || leg.voidFactor === "1" || leg.voidFactor === "1.0") {
      continue;
    }

    if (leg.result === "won") {
      // Won leg: probability = 1 (locked in), but the leg's full odds
      // are still part of ticketOdds — the user's payout if all
      // remaining legs win is still stake × Π(allLegOdds). See doc
      // EXAMPLE 2: a 10-fold with 9 won legs is still worth
      // stake × 100 × P(last leg).
      ticketOdds *= parseFiniteFloat(leg.oddsAtPlacement);
      continue;
    }

    if (leg.result === "half_won") {
      // Effective odds contribution = 1 + (odds-1)/2 (matches Sportradar
      // §1.3 payoutIfTicketWinsHalf). Probability collapses to 1.
      const o = parseFiniteFloat(leg.oddsAtPlacement);
      ticketOdds *= 1 + (o - 1) * 0.5;
      continue;
    }
    if (leg.result === "half_lost") {
      // Half-lost: only half the stake stays in the bet — leg
      // contributes a multiplier of 0.5. Probability collapses to 1.
      ticketOdds *= 0.5;
      continue;
    }

    // Unsettled leg — must be active and have a price.
    if (!leg.active) {
      return blank("leg_inactive");
    }
    const odds = parseFiniteFloat(leg.oddsAtPlacement);
    ticketOdds *= odds;

    let p: number | null = leg.probabilityCurrent;
    if (p === null && leg.oddsCurrent) {
      // Fallback to implied probability from current odds. Fair-prob
      // would be 1/oddsRaw, but Oddin's odds already carry margin so
      // 1/odds is a slight under-estimate of the bookmaker's true
      // probability. Per the docs we accept this trade-off until the
      // probability attribute is universally populated.
      const oc = parseFiniteFloat(leg.oddsCurrent);
      if (oc > 0) p = 1 / oc;
    }
    if (p === null || !Number.isFinite(p) || p <= 0 || p >= 1.0001) {
      // Allow probability slightly above 1 only when it's a rounding
      // artifact (oddin sometimes ships 1.0001 etc.). Anything else,
      // treat as no offer.
      if (p !== null && p > 1 && p <= 1.0001) {
        p = 1;
      } else {
        return blank("leg_no_probability");
      }
    }
    probability *= p;
  }

  // Simple cashout (no margin): stake × ticketOdds × probability.
  // We compute in floats then convert to micro to keep the implementation
  // close to the Sportradar reference. Precision loss is a few atomic
  // micro_usdt at worst.
  const stakeNum = Number(input.stakeMicro);
  const fairOfferFloat = stakeNum * ticketOdds * probability;
  const ticketValueFairMicro = BigInt(Math.floor(fairOfferFloat));

  let offerMicro = ticketValueFairMicro;
  let deductionFactor: number | null = null;

  if (input.config.deductionLadder && input.config.deductionLadder.length > 0) {
    deductionFactor = lookupLadder(
      input.config.deductionLadder,
      stakeNum > 0 ? fairOfferFloat / stakeNum : 1,
    );
    offerMicro = BigInt(Math.floor(Number(ticketValueFairMicro) / deductionFactor));
  }

  if (fullPaybackWindow) {
    offerMicro = input.stakeMicro;
  }

  // Hard cap at potential payout — the docs warn that naive offers can
  // exceed payoutIfWin (Sportradar §2.2.1). We never want that.
  if (offerMicro > input.potentialPayoutMicro) {
    offerMicro = input.potentialPayoutMicro;
  }

  // Significant-change gate. |currentValue/stake - 1| must clear the
  // threshold. fullPayback bypasses (the gate is already satisfied by
  // intent — user wants their stake back).
  if (
    !fullPaybackWindow &&
    input.config.minValueChangeBp > 0 &&
    stakeNum > 0
  ) {
    const ratio = fairOfferFloat / stakeNum;
    const change = Math.abs(ratio - 1) * 10000;
    if (change < input.config.minValueChangeBp) {
      return {
        available: false,
        reason: "below_change_threshold",
        offerMicro: 0n,
        ticketOdds,
        probability,
        ticketValueFairMicro,
        deductionFactor,
        fullPayback: false,
      };
    }
  }

  if (offerMicro < input.config.minOfferMicro) {
    return {
      available: false,
      reason: "below_minimum",
      offerMicro,
      ticketOdds,
      probability,
      ticketValueFairMicro,
      deductionFactor,
      fullPayback: fullPaybackWindow,
    };
  }

  return {
    available: true,
    offerMicro,
    ticketOdds,
    probability,
    ticketValueFairMicro,
    deductionFactor,
    fullPayback: fullPaybackWindow,
  };
}

/**
 * Linear interpolation through the ladder. The Excel uses the same
 * approach (cell M13 in the workbook). Returns the deduction factor
 * for the supplied valueRatio (= currentTicketValue / stake).
 */
export function lookupLadder(
  ladder: CashoutLadderStep[],
  valueRatio: number,
): number {
  if (ladder.length === 0) return 1;
  // Sort defensively; admin UI normally writes in order but we don't
  // want to depend on that.
  const sorted = [...ladder].sort((a, b) => a.factor - b.factor);
  if (valueRatio <= sorted[0]!.factor) return sorted[0]!.deduction;
  if (valueRatio >= sorted[sorted.length - 1]!.factor) {
    return sorted[sorted.length - 1]!.deduction;
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    const lo = sorted[i]!;
    const hi = sorted[i + 1]!;
    if (valueRatio >= lo.factor && valueRatio <= hi.factor) {
      const t = (valueRatio - lo.factor) / (hi.factor - lo.factor);
      return lo.deduction + t * (hi.deduction - lo.deduction);
    }
  }
  return sorted[sorted.length - 1]!.deduction;
}

function blank(
  reason: CashoutUnavailableReason,
  carry: { ticketOdds?: number; probability?: number } = {},
): ComputeOutput {
  return {
    available: false,
    reason,
    offerMicro: 0n,
    ticketOdds: carry.ticketOdds ?? 0,
    probability: carry.probability ?? 0,
    ticketValueFairMicro: 0n,
    deductionFactor: null,
    fullPayback: false,
  };
}

function parseFiniteFloat(s: string): number {
  const f = Number(s);
  if (!Number.isFinite(f) || f <= 0) {
    throw new Error(`invalid decimal: ${s}`);
  }
  return f;
}
