// ZillaTips — per-market historical performance widget. The API computes
// per-(marketId, outcomeId, team-role) ROI from the last N closed matches
// the team played with the same (provider_market_id, specifiers_hash)
// signature, and only returns tips whose ROI clears MIN_ROI_THRESHOLD.
//
// The widget's display rules (highlight tiers, "show button" gate) come
// straight from the thresholds below so the API and the storefront stay
// in lockstep. Anything that wants to render or evaluate a tip can
// import from this module.
//
// Result colour mapping (won/lost/void) is left to the storefront — the
// API ships the raw outcome_result enum string so future result types
// (e.g. half_won) render correctly without a contract bump.

export type ZillaTipResult =
  | "won"
  | "lost"
  | "void"
  | "half_won"
  | "half_lost";

export type ZillaTipRole = "home" | "away";

// One historical leg in a tip — i.e. one row in the popover. Voids /
// unrated legs are kept in the array so the user sees a complete 5-game
// trail; the ROI in the parent tip excludes them from its denominator.
export interface ZillaTipLeg {
  // Historical match id (string-serialised bigint).
  histMatchId: string;
  // Which side the focused team was on in this historical match.
  // Drives label/logo resolution (the "opponent" is the other side).
  teamRoleHist: ZillaTipRole;
  // The opponent (the side that wasn't `teamRoleHist`). Logo + brand
  // colour are nullable when the historical competitor row has no
  // branding (auto-mapper hasn't resolved a URN yet, or admin hasn't
  // uploaded a logo).
  opponentLabel: string;
  opponentLogoUrl: string | null;
  opponentBrandColor: string | null;
  // Final prematch odds for the team-equivalent outcome on the historical
  // match, captured at the not_started→live transition. Null when the
  // historical match closed before migration 0047 (no snapshot exists);
  // the leg is then shown but excluded from ROI.
  prematchOdds: string | null;
  result: ZillaTipResult | null;
  // The historical equivalent outcome id (1↔2 swap applied for
  // team-specific markets when role differs). Exposed for debugging
  // and future "show me the same line" deeplinks.
  equivOutcomeId: string;
  liveStartedAt: string;
  scheduledAt: string | null;
}

export interface ZillaTip {
  marketId: string; // bigint serialised as string
  outcomeId: string;
  teamId: number;
  // The team's role on the CURRENT (open) match. Drives which row of the
  // widget renders this tip — `home` lines up under the home banner.
  role: ZillaTipRole;
  // Aggregate flat-stake ROI over `ratedCount` legs, expressed as a
  // unitless multiplier: 0.20 = +20%, 1.00 = +100%.
  // Always >= MIN_ROI_THRESHOLD by construction.
  roi: number;
  // How many legs contributed to the ROI denominator. Legs with a void
  // result or a won-with-null-prematch-odds are excluded.
  ratedCount: number;
  // Total leg count (rated + void + unrated). Always ≤ 5.
  sampleSize: number;
  legs: ZillaTipLeg[];
}

export interface ZillaTipsResponse {
  matchId: string;
  // Empty when no tip on any of the match's active markets clears the
  // ROI gate. The storefront uses presence (length > 0) to decide
  // whether to even mount the widgets layer.
  tips: ZillaTip[];
}

// Minimum aggregate ROI a (market, outcome, team-role) tip must clear
// to surface in the API response. 0.20 = +20% ⇒ over the last N rated
// matches a flat-stake bettor would have been ahead by 20% of stake.
export const ZILLATIP_MIN_ROI = 0.2;

// Visual highlight ladder, in ascending ROI. The storefront looks at
// the tip's `roi` against these breakpoints and bumps the surrounding
// chrome accordingly (default → glow → fire).
export const ZILLATIP_TIER_GLOW = 1.0; // ≥ +100%
export const ZILLATIP_TIER_FIRE = 3.0; // ≥ +300%

export type ZillaTipTier = "base" | "glow" | "fire";

export function zillaTipTier(roi: number): ZillaTipTier {
  if (roi >= ZILLATIP_TIER_FIRE) return "fire";
  if (roi >= ZILLATIP_TIER_GLOW) return "glow";
  return "base";
}

// How many historical matches the API looks back over per (market,
// team) pair. Bounded by the LATERAL LIMIT in the SQL and the
// `lookback_days` window — both live in the route handler so changing
// them is a single-PR adjustment.
export const ZILLATIP_LOOKBACK_LEGS = 5;
