// Oddin BetBuilder (OBB) wire types. Used by both the frontend and the
// services/api server. Mirrors `proto/obb/*.proto` from the vendored
// schema, with the gRPC details (uint64 odds, oneof status) flattened
// into a JSON shape the slip can consume.

export interface BetBuilderSelectionInput {
  /** Internal market id (BIGINT-as-string), aligns with bet slip. */
  marketId: string;
  /** Outcome id (Oddin "<outcome>" attribute, e.g. "1" or "od:player:N"). */
  outcomeId: string;
}

export interface BetBuilderQuoteRequest {
  /**
   * Internal match id. The server re-derives the Oddin event URN
   * (`od:match:N`), provider market ids and specifiers from our own
   * tables — clients never craft selection_id strings directly.
   */
  matchId: string;
  selections: BetBuilderSelectionInput[];
}

/**
 * Outcome inside an OBB session response. Keys mirror Oddin's gRPC
 * SessionMarketOutcome — odds × 10_000 stored unboxed, decimal odds
 * derived for display.
 */
export interface BetBuilderAvailableOutcome {
  outcomeId: string;
  /** Decimal odds rendered to 2 decimals — e.g. "1.85". */
  odds: string;
  oddsX10000: number;
  /** Optional implied probability (Oddin's raw_probability, decimal). */
  rawProbability?: string;
}

/**
 * One available market that the user could still add to the current
 * session. provider_market_id + specifiers come straight from Oddin and
 * are mapped to internal market ids by the API before returning.
 */
export interface BetBuilderAvailableMarket {
  /** Internal market id when we have one mapped; null for unmapped. */
  marketId: string | null;
  providerMarketId: number;
  specifiers: string;
  outcomes: BetBuilderAvailableOutcome[];
}

export interface BetBuilderQuoteAcceptedResponse {
  status: "accepted";
  /** Oddin session id; round-tripped to /bets at placement. */
  sessionId: string;
  /** Selection IDs as Oddin echoed them; saved on the ticket meta. */
  selectionIds: string[];
  /** Combined session odds × 10_000 — the value Oddin returns. */
  oddsX10000: number;
  /** Combined session odds, decimal-formatted to 2 decimals. */
  combinedOdds: string;
  /** Optional implied combined probability. */
  rawProbability?: string;
  /** Markets still available to add to this session. */
  availableMarkets: BetBuilderAvailableMarket[];
}

export interface BetBuilderQuoteRejectedResponse {
  status: "rejected";
  reason:
    | "internal"
    | "invalid_argument"
    | "invalid_market_combination"
    | "inactive_market"
    | "unknown";
  message: string;
  /** Per-selection reasons keyed by Oddin selection_id, when provided. */
  selectionsRejected?: Record<string, { code: string; message: string }>;
}

export type BetBuilderQuoteResponse =
  | BetBuilderQuoteAcceptedResponse
  | BetBuilderQuoteRejectedResponse;

/**
 * Used purely for paint: when the match page mounts in BetBuilder mode
 * before the user picked any selection, we fetch the AvailableMarkets
 * list so the UI can disable markets the bookmaker doesn't allow in OBB.
 */
export interface BetBuilderAvailableMarketsResponse {
  /** Internal market ids that are eligible for this match's OBB session. */
  marketIds: string[];
  /** Provider-side raw list — useful for admin debugging only. */
  raw: Array<{ providerMarketId: number; specifiers: string }>;
}
