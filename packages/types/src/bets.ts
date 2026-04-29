// Shared types for the bet slip + placement + history flows.
//
// Money values cross the wire as strings (decimal or micro) to preserve
// bigint precision through JSON. The frontend converts with
// `toMicro()` / `fromMicro()` from ./money.

import type { Currency } from "./currencies.js";
import type { BetMeta } from "./products.js";

export type BetType = "single" | "combo" | "system" | "tiple" | "tippot";

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
  // Implied probability when the catalog ships it. Used purely client-
  // side to preview tiple/tippot pricing — the server reads its own
  // copy from market_outcomes at placement, so this is informational.
  probability?: string;
  homeTeam: string;
  awayTeam: string;
  marketLabel: string;       // human display: "Match Winner", "Map Winner — Map 1"
  outcomeLabel: string;      // e.g. team name or "Map 1 winner"
  sportSlug: string;
}

export interface PlaceBetRequest {
  stakeMicro: string;        // bigint as string
  idempotencyKey: string;    // client-supplied UUID
  currency?: Currency;       // wallet to debit; defaults to USDT for compat
  /**
   * Optional explicit product. Inferred when absent: 1 leg → "single",
   * ≥ 2 → "combo". For tiple/tippot the client must send it explicitly;
   * the server reads each leg's probability from market_outcomes (never
   * trusts client-supplied values) and prices fresh.
   */
  betType?: BetType;
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
  currency: Currency;
  stakeMicro: string;
  potentialPayoutMicro: string;
  actualPayoutMicro: string | null;
  notBeforeTs: string | null;
  rejectReason: string | null;
  placedAt: string;
  acceptedAt: string | null;
  settledAt: string | null;
  // Frozen at placement for tiple/tippot — null for single/combo. Carries
  // the per-tier multiplier schedule for tippot so the UI can render the
  // payout table without recomputing.
  betMeta: BetMeta | null;
  selections: Array<{
    marketId: string;
    outcomeId: string;
    oddsAtPlacement: string;
    probabilityAtPlacement: string | null;
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
