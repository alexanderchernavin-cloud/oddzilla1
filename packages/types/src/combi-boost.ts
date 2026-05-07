// Combi Boost (a.k.a. accumulator boost) — payout-multiplier promo on
// combo tickets. Two clients use the math here:
//
//   - Web bet-slip rail: previews the boost as the user adds legs.
//   - API place-bet:     applies the boost to potentialPayoutMicro at
//                        placement, freezes the multiplier into
//                        tickets.bet_meta (ComboMeta) so settlement can
//                        re-apply it without recomputing eligibility.
//
// The settlement service reads the multiplier verbatim from bet_meta —
// it never re-evaluates leg eligibility, because the legs' odds at
// placement are what counted, not the live odds at settlement time.

/** Per-leg odds floor. Legs strictly below this don't count toward the leg-tier threshold. */
export const COMBI_BOOST_MIN_ODDS = 1.5;

export interface CombiBoostTier {
  /** Minimum eligible-leg count to unlock this tier. Strictly increasing across the array. */
  minLegs: number;
  /** Payout multiplier applied to the combo payout (e.g., 1.03 = +3%). */
  multiplier: number;
  /** Display string, mirroring betby/competitor convention. */
  label: string;
}

/**
 * Tier table, lowest threshold first. Edits here propagate to web,
 * API, and (via bet_meta JSON) the settlement service.
 */
export const COMBI_BOOST_TIERS: readonly CombiBoostTier[] = [
  { minLegs: 2, multiplier: 1.03, label: "x1.03" },
  { minLegs: 4, multiplier: 1.05, label: "x1.05" },
  { minLegs: 6, multiplier: 1.08, label: "x1.08" },
  { minLegs: 8, multiplier: 1.12, label: "x1.12" },
] as const;

export interface CombiBoostState {
  /** Eligible legs (odds >= COMBI_BOOST_MIN_ODDS), capped at the configured cells (8). */
  eligibleLegCount: number;
  /** Current effective multiplier; 1.0 when no tier reached. */
  multiplier: number;
  /** The tier object the user is currently on, or null if none. */
  currentTier: CombiBoostTier | null;
  /** The next tier (highest-paying), or null when already at the top. */
  nextTier: CombiBoostTier | null;
  /** Eligible legs still needed to reach `nextTier` (0 when at top). */
  legsToNextTier: number;
}

function parseLegOdds(raw: ReadonlyArray<number | string>): number[] {
  const out: number[] = [];
  for (const v of raw) {
    const n = typeof v === "number" ? v : Number.parseFloat(v);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Compute the boost state for a given set of leg-odds. Pass numbers or
 * decimal strings; non-finite entries are ignored. Order is irrelevant.
 */
export function computeCombiBoost(
  legOdds: ReadonlyArray<number | string>,
): CombiBoostState {
  const odds = parseLegOdds(legOdds);
  const eligible = odds.filter((o) => o >= COMBI_BOOST_MIN_ODDS).length;

  let currentTier: CombiBoostTier | null = null;
  let nextTier: CombiBoostTier | null = null;
  for (const tier of COMBI_BOOST_TIERS) {
    if (eligible >= tier.minLegs) {
      currentTier = tier;
    } else if (!nextTier) {
      nextTier = tier;
    }
  }

  return {
    eligibleLegCount: eligible,
    multiplier: currentTier ? currentTier.multiplier : 1.0,
    currentTier,
    nextTier,
    legsToNextTier: nextTier ? Math.max(0, nextTier.minLegs - eligible) : 0,
  };
}

/** Convenience for callers that only need the multiplier number. */
export function combiBoostMultiplierFor(
  legOdds: ReadonlyArray<number | string>,
): number {
  return computeCombiBoost(legOdds).multiplier;
}
