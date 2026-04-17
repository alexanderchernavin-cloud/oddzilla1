// Shared types for the bet slip + placement + history flows.
//
// Money values cross the wire as strings (decimal or micro) to preserve
// bigint precision through JSON. The frontend converts with
// `toMicro()` / `fromMicro()` from ./money.

export type BetType = "single" | "combo" | "system";

export type TicketStatus =
  | "pending_delay"
  | "accepted"
  | "rejected"
  | "settled"
  | "voided"
  | "cashed_out";

export type OutcomeResult = "won" | "lost" | "void" | "half_won" | "half_lost";

export interface SlipSelection {
  matchId: string;           // BIGINT as string
  marketId: string;          // BIGINT as string
  outcomeId: string;
  // Snapshot data the user sees at the moment of selection. The server
  // re-validates all of these against current state at placement time.
  odds: string;              // decimal as string, e.g. "1.85"
  homeTeam: string;
  awayTeam: string;
  marketLabel: string;       // human display: "Match Winner", "Map Winner — Map 1"
  outcomeLabel: string;      // e.g. team name or "Map 1 winner"
  sportSlug: string;
}

export interface PlaceBetRequest {
  stakeMicro: string;        // bigint as string
  idempotencyKey: string;    // client-supplied UUID
  selections: Array<{
    marketId: string;
    outcomeId: string;
    odds: string;            // decimal odds as displayed at click time
  }>;
}

export interface PlaceBetResponse {
  ticket: TicketSummary;
}

export interface TicketSummary {
  id: string;                // UUID
  status: TicketStatus;
  betType: BetType;
  stakeMicro: string;
  potentialPayoutMicro: string;
  actualPayoutMicro: string | null;
  notBeforeTs: string | null;
  rejectReason: string | null;
  placedAt: string;
  acceptedAt: string | null;
  settledAt: string | null;
  selections: Array<{
    marketId: string;
    outcomeId: string;
    oddsAtPlacement: string;
    result: OutcomeResult | null;
    voidFactor: string | null;
    market?: {
      providerMarketId: number;
      specifiers: Record<string, string>;
      matchId: string;
      homeTeam: string;
      awayTeam: string;
      sportSlug: string;
    };
  }>;
}

export interface TicketListResponse {
  tickets: TicketSummary[];
}

// WebSocket ticket-state frame pushed by API (on placement) and bet-delay
// (on finalization). Distinct from the `odds` frame already defined in ws.ts.
export interface WsTicketFrame {
  type: "ticket";
  ticketId: string;
  status: TicketStatus;
  rejectReason?: string | null;
  actualPayoutMicro?: string | null;
}

// Odds-drift tolerance — fraction. A placement odds of 1.85 accepts a
// current market price in [1.85 * (1 - t), 1.85 * (1 + t)]. Defaults match
// the bet-delay worker's compile-time default but are intentionally
// duplicated so the frontend can warn the user before submit.
export const DEFAULT_ODDS_DRIFT_TOLERANCE = 0.05; // 5%
