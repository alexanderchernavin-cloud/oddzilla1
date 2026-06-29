// ZillaBuild — admin-curated pre-built BetBuilder (Oddin OBB) combos
// surfaced as cards on the PREMATCH match page. Each card is a random
// 2-4 leg single-map combo whose composition is persisted server-side
// (chosen once, kept while its legs stay valid) and whose odds are
// re-quoted from OBB on every match-page open.
//
// Sibling promo to ZillaFlash + CombiBoost — see zillaflash.ts /
// combi-boost.ts. Wire shape consumed by both the storefront widget
// (apps/web) and the api.

/** One leg of a ZillaBuild card. */
export interface ZillaBuildLeg {
  /** Internal market id (BIGINT-as-string), aligns with the bet slip. */
  marketId: string;
  /** Oddin outcome id (e.g. "1" or "od:player:N"). */
  outcomeId: string;
  /** Specifier-substituted market name (e.g. "Map 1 winner"). */
  marketLabel: string;
  /** Outcome display label (team name, "Over 12.5", etc.). */
  outcomeLabel: string;
  /** Current per-leg published odds, formatted (display only). */
  odds: string;
}

/** One pre-built card: a single-map combo of 2-4 legs. */
export interface ZillaBuildCard {
  /** Persisted card id (zillabuild_cards.id, BIGINT-as-string). */
  id: string;
  /** Map this card's legs all belong to (1-based). */
  mapNumber: number;
  /** Slot within the map (0-based) — stable per (match, map). */
  slot: number;
  legs: ZillaBuildLeg[];
  /** OBB combined session odds, decimal-formatted to 2 decimals. */
  combinedOdds: string;
  /** OBB combined session odds × 10 000 (the value Oddin returns). */
  combinedOddsX10000: number;
}

export interface ZillaBuildResponse {
  /** Master feature flag (false → storefront hides the section). */
  enabled: boolean;
  /**
   * Every OBB-eligible internal market id for this match. The storefront
   * pushes these into the bet slip's BetBuilder eligibility list when a
   * card is loaded, so LiveMarkets greys out non-OBB outcomes.
   */
  eligibleMarketIds: string[];
  /** Up to (cardsPerMap × mapCount) cards, sorted by map then slot. */
  cards: ZillaBuildCard[];
}

/** Admin-tunable feature config (mirrors zillabuild_config columns). */
export interface ZillaBuildConfigLive {
  enabled: boolean;
  /** Allowlist of Oddin provider_market_id values; empty = all eligible. */
  eligibleProviderMarketIds: number[];
  cardsPerMap: number;
  mapCount: number;
  minLegs: number;
  maxLegs: number;
  /** Combined-odds floor; cards below it are rejected during generation. */
  minCombinedOdds: number;
  /** Shared per-match response cache window, seconds. */
  cacheTtlSeconds: number;
}

/**
 * Default config — mirrors the DB defaults in migration 0082. Used as the
 * catalog fallback when the singleton row is missing and as the admin
 * form seed.
 */
export const ZILLABUILD_DEFAULT_CONFIG: ZillaBuildConfigLive = {
  enabled: true,
  eligibleProviderMarketIds: [],
  cardsPerMap: 2,
  mapCount: 2,
  minLegs: 2,
  maxLegs: 4,
  minCombinedOdds: 2.0,
  cacheTtlSeconds: 20,
} as const;
