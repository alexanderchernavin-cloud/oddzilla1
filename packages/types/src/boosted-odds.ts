// Custom Boosted Odds — operator-curated boosts pinned to a sport /
// tournament / match / competitor (team) / single market (migration
// 0085). Boost math is the same Netwinstable key delta ZillaFlash uses
// (netwinstable.ts boostMarketKey): boost_pct percentage points shaved
// off the market's key, recomputed from live published_odds on every
// read, clamped so the book never reaches fair.
//
// Delivery is gated per bettor by the rule's optional minRiskScore —
// users.risk_score below the threshold sees the standard price.
// Resolution per market when several rules overlap:
//     market > match > competitor > tournament > sport
// (two competitor rules on the same match resolve to the higher pct).

export type BoostedOddsScope =
  | "sport"
  | "tournament"
  | "match"
  | "competitor"
  | "market";

/**
 * Tolerance for "did the user click the price we compute now" at bet
 * placement. Same rationale + value as ZILLAFLASH_PLACEMENT_TOLERANCE:
 * boosted odds drift sub-cent as the underlying ticks and the display
 * is 2 decimals, so 0.01 is generous.
 */
export const CUSTOM_BOOST_PLACEMENT_TOLERANCE = 0.01;

/** Risk score assumed for anonymous viewers (matches users.risk_score default). */
export const CUSTOM_BOOST_DEFAULT_RISK_SCORE = 1.0;

/**
 * One boosted market on a match, as served by
 * GET /catalog/matches/:id/boosted-odds. Carries only the RULE — no
 * prices. Boosted prices are computed client-side with boostMarketKey
 * over the live outcome set the page already tracks via WS ticks, so
 * the boost moves in the same render as the raw odds (true realtime);
 * this endpoint only propagates admin rule changes and the per-viewer
 * Min Risk Score gate. The server recomputes the same math at
 * placement and compares within CUSTOM_BOOST_PLACEMENT_TOLERANCE.
 */
export interface CustomBoostedMarket {
  /** boosted_odds_config.id — round-trips through POST /bets per leg. */
  ruleId: string;
  marketId: string;
  /** Netwinstable key delta in percentage points. */
  boostPct: number;
  /** ISO end time, or null = boost runs until the operator removes it (no countdown). */
  endsAt: string | null;
}

export interface CustomBoostedOddsResponse {
  entries: CustomBoostedMarket[];
  /** Server-time at response build so clients can correct clock skew. */
  serverNow: string;
}

/**
 * Canonical formatting for boosted prices — floor to 2 decimals, the
 * same quoting shape ZillaFlash uses. MUST stay byte-identical between
 * the client (live recompute from WS ticks) and the api (placement
 * re-validation): both sides format through this one function so the
 * ±0.01 placement tolerance only ever absorbs real tick drift, never
 * formatting skew.
 */
export function formatBoostedOdds(n: number): string {
  if (!Number.isFinite(n)) return "0.00";
  return (Math.floor(n * 100) / 100).toFixed(2);
}
