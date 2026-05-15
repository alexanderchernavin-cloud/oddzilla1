// ZillaFlash — boosted-odds promo. The API keeps 4 active offers at any
// time: 2 prematch (60 s TTL) + 2 live (15 s TTL). When an offer expires
// the rotation picks a fresh (random Tier 1-3 match, sport-top-market)
// pair, applies a -3pp Netwinstable key adjustment, and emits the next
// offer.
//
// Each offer's boostedOdds reflect the LATEST underlying outcome odds at
// the time the storefront polls — so live offers visibly tick up/down as
// the published odds move, and the boost ratio stays consistent. The
// frontend re-validates the offer with the server at slip submission;
// stale boost → 400, refresh and re-quote.

export type ZillaFlashKind = "prematch" | "live";

/** -3 percentage points off the current key. Locked, not admin-tunable. */
export const ZILLAFLASH_KEY_DELTA_PCT = 3;

/** Live ZillaFlash legs shave 2 s off the per-match acceptance delay. */
export const ZILLAFLASH_LIVE_DELAY_SHAVE_SECONDS = 2;

export const ZILLAFLASH_TTL_MS: Record<ZillaFlashKind, number> = {
  prematch: 60_000,
  live: 15_000,
};

/** Number of active offers maintained per kind. */
export const ZILLAFLASH_SLOTS_PER_KIND = 2;

export interface ZillaFlashOffer {
  /** Stable per-offer id. Must round-trip through POST /bets. */
  id: string;
  kind: ZillaFlashKind;

  /** Catalog metadata — used by the card for navigation + labels. */
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  sportSlug: string;
  sportName: string;

  /** The boosted leg. */
  marketId: string;
  providerMarketId: number;
  marketLabel: string;
  outcomeId: string;
  outcomeLabel: string;

  /**
   * Original (pre-boost) published odds for the boosted outcome. Used
   * for the crossed-out original-price chip on the card.
   */
  originalOdds: string;
  /** Boosted, key-adjusted odds for the same outcome. The price the bet pays at. */
  boostedOdds: string;

  /** Snapshot of every outcome's odds in the same market (post-boost), for liveness display. */
  marketSnapshot: Array<{
    outcomeId: string;
    outcomeLabel: string;
    originalOdds: string;
    boostedOdds: string;
  }>;

  /** Wall-clock ISO timestamps. The countdown is computed client-side. */
  startedAt: string;
  expiresAt: string;
  /** Server-time at response build, so the client can correct for clock skew. */
  serverNow: string;
}

export interface ZillaFlashResponse {
  prematch: ZillaFlashOffer[];
  live: ZillaFlashOffer[];
  /** True if either rotation is empty due to no eligible candidates. */
  empty: boolean;
}
