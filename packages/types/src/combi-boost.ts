// Combi Boost (a.k.a. accumulator boost) — payout-multiplier promo on
// combo tickets. Three callers use the math here:
//
//   - Web bet-slip rail + lobby cards: previews the boost as the user
//     adds legs.
//   - API place-bet: applies the boost to potentialPayoutMicro at
//     placement, freezes the multiplier into tickets.bet_meta
//     (ComboMeta) so settlement can re-apply it without recomputing
//     eligibility.
//
// The settlement service reads the multiplier verbatim from bet_meta —
// it never re-evaluates leg eligibility, because the legs' odds at
// placement are what counted, not the live odds at settlement time.
//
// Tier table is admin-tunable. The defaults below match the seed in
// migration 0032 so the function stays useful in tests and as a fallback
// when no config has been loaded; production callers should pass the DB
// config to keep behavior in sync with /admin/combi-boost-config.

/** Default per-leg odds floor when no config is supplied. Mirrors migration 0032. */
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
 * Default tier table, lowest threshold first. Used as a fallback when
 * no DB-backed config is in scope (tests, early bootstrap). Production
 * code paths should pass the live config from
 * /catalog/combi-boost-config or admin GET so changes in the admin UI
 * propagate without a redeploy.
 */
export const COMBI_BOOST_TIERS: readonly CombiBoostTier[] = [
  { minLegs: 2, multiplier: 1.03, label: "x1.03" },
  { minLegs: 4, multiplier: 1.05, label: "x1.05" },
  { minLegs: 6, multiplier: 1.08, label: "x1.08" },
  { minLegs: 8, multiplier: 1.12, label: "x1.12" },
] as const;

/** Full config shape served by the API. */
export interface CombiBoostConfigLive {
  enabled: boolean;
  minOdds: number;
  tiers: readonly CombiBoostTier[];
}

/** Default config — used as a fallback when no live config is supplied. */
export const COMBI_BOOST_DEFAULT_CONFIG: CombiBoostConfigLive = {
  enabled: true,
  minOdds: COMBI_BOOST_MIN_ODDS,
  tiers: COMBI_BOOST_TIERS,
} as const;

/** Format a multiplier as the standard "x1.NN" / "x2.NN" label. */
export function formatBoostLabel(multiplier: number): string {
  return `x${multiplier.toFixed(2)}`;
}

export interface CombiBoostState {
  /** Eligible legs (odds >= effective min), capped at the configured cells. */
  eligibleLegCount: number;
  /** Current effective multiplier; 1.0 when no tier reached or feature disabled. */
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
 * Compute the boost state for a given set of leg odds.
 *
 * Pass `config` to use admin-tunable values from the DB. When omitted
 * the function falls back to COMBI_BOOST_DEFAULT_CONFIG so tests and
 * legacy callers keep working unchanged.
 */
export function computeCombiBoost(
  legOdds: ReadonlyArray<number | string>,
  config: CombiBoostConfigLive = COMBI_BOOST_DEFAULT_CONFIG,
): CombiBoostState {
  if (!config.enabled) {
    return {
      eligibleLegCount: 0,
      multiplier: 1.0,
      currentTier: null,
      nextTier: null,
      legsToNextTier: 0,
    };
  }
  const odds = parseLegOdds(legOdds);
  const eligible = odds.filter((o) => o >= config.minOdds).length;

  let currentTier: CombiBoostTier | null = null;
  let nextTier: CombiBoostTier | null = null;
  for (const tier of config.tiers) {
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
  config?: CombiBoostConfigLive,
): number {
  return computeCombiBoost(legOdds, config).multiplier;
}
