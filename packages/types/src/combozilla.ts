// ComboZilla — the lobby's prebuilt 3-fold carousel. Wire shapes shared
// by the api (GET /catalog/combozilla-pool, /admin/combozilla-config),
// the storefront builder (apps/web/src/lib/three-fold-builder.ts) and the
// backoffice editor (apps/web/src/app/admin/combozilla/).
//
// The selection POLICY — which matches may feed the carousel — is decided
// server-side in services/api/src/lib/combozilla.ts from the operator's
// config (migration 20260906T015446_combozilla_config). The storefront
// only assembles combos out of what the pool endpoint hands it, so the
// backoffice and the lobby cannot disagree about eligibility.
//
// Import via the `@oddzilla/types/combozilla` subpath, never the barrel
// (see the oddzilla-types-barrel-imports footgun).

export const COMBOZILLA_RULE_SCOPES = ["sport", "category", "tournament"] as const;
export type ComboZillaRuleScope = (typeof COMBOZILLA_RULE_SCOPES)[number];

export const COMBOZILLA_RULE_MODES = ["allow", "block"] as const;
export type ComboZillaRuleMode = (typeof COMBOZILLA_RULE_MODES)[number];

/** Every tier a tournament can carry (`tournaments.risk_tier`). */
export const COMBOZILLA_ALL_RISK_TIERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/**
 * Defaults, mirroring the migration's column defaults. These reproduce
 * the behaviour the builder had hard-coded before the config existed, so
 * an estate that has never opened the backoffice page renders exactly
 * what it did.
 */
export const COMBOZILLA_DEFAULT_ELIGIBLE_RISK_TIERS: readonly number[] = [1, 2, 3];
export const COMBOZILLA_DEFAULT_MULTI_CARD_SPORT_SLUGS: readonly string[] = [
  "cs2",
  "dota2",
  "lol",
];

/** The singleton row as the admin API serves it. */
export interface ComboZillaConfigDto {
  enabled: boolean;
  eligibleRiskTiers: number[];
  allowUntiered: boolean;
  multiCardSportSlugs: string[];
  updatedAt: string;
  updatedBy: string | null;
}

/** One operator override, hydrated with the names the row points at. */
export interface ComboZillaRuleDto {
  id: string;
  scope: ComboZillaRuleScope;
  mode: ComboZillaRuleMode;
  /** The referenced entity — sport, category or tournament. */
  refId: number;
  name: string;
  /** Owning sport, for every scope (a sport's own row repeats itself). */
  sport: { id: number; slug: string; name: string };
  /** Owning category for category + tournament rules; null for sport rules. */
  category: { id: number; name: string } | null;
  /** The tournament's tier, so the operator can see what the rule overrides. */
  riskTier: number | null;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * What the current policy admits right now, grouped for the backoffice
 * preview. Counts are prematch matches with a bettable offer, the same
 * population the storefront pool draws from.
 */
export interface ComboZillaPreviewDto {
  totalMatches: number;
  sports: Array<{
    id: number;
    slug: string;
    name: string;
    matchCount: number;
    tournaments: Array<{
      id: number;
      name: string;
      categoryName: string | null;
      riskTier: number | null;
      matchCount: number;
    }>;
  }>;
}

/** One match-winner side as the pool serves it (per-bettor adjusted). */
export interface ComboZillaPoolOutcome {
  outcomeId: string;
  price: string | null;
  probability: string | null;
}

/** One candidate match in the pool. */
export interface ComboZillaPoolMatch {
  id: string;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string | null;
  status: string;
  sport: { id: number; slug: string; name: string };
  tournament: { id: number; name: string; riskTier: number | null };
  matchWinner: {
    marketId: string;
    home: ComboZillaPoolOutcome;
    away: ComboZillaPoolOutcome;
  } | null;
}

/** GET /catalog/combozilla-pool. */
export interface ComboZillaPoolResponse {
  enabled: boolean;
  multiCardSportSlugs: string[];
  matches: ComboZillaPoolMatch[];
}
