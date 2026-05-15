// Shared types for the bet slip + placement + history flows.
//
// Money values cross the wire as strings (decimal or micro) to preserve
// bigint precision through JSON. The frontend converts with
// `toMicro()` / `fromMicro()` from ./money.

import type { Currency } from "./currencies.js";
import type { BetMeta } from "./products.js";

export type BetType =
  | "single"
  | "combo"
  | "system"
  | "tiple"
  | "tippot"
  // BetBuilder: multiple selections from the SAME match, priced via
  // Oddin's OBB gRPC service. session_id + final session odds frozen in
  // tickets.bet_meta at placement; settlement does NOT multiply per-leg
  // odds.
  | "betbuilder";

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
  // The price the user has accepted. Frozen at click time and held
  // stable across WS odds drift until the user explicitly accepts an
  // update via slip.acceptPendingOdds(). Submitted to POST /bets so
  // the server's drift check compares against what the user actually
  // chose, not against the latest broker tick.
  odds: string;              // decimal as string, e.g. "1.85"
  // Implied probability matching `odds` (purely informational — the
  // server reads its own copy from market_outcomes at placement and
  // never trusts client-supplied probabilities).
  probability?: string;
  // Whether the outcome is currently bettable. Refreshed by the slip
  // rail's WS auto-refresh so the user can't hit "Place bet" on an
  // outcome that flipped suspended after they clicked. The server
  // re-validates this at placement (outcome.active + market.status),
  // so the client-side flag is purely a UX gate. Defaults to true for
  // back-compat with selections persisted before this field existed.
  active?: boolean;
  // Latest broker odds when they differ from the user-accepted `odds`
  // above. Set by the rail's WS auto-refresh; cleared whenever the
  // tick matches `odds` again or the user clicks "Accept odds change"
  // (which copies pending → odds). When `pendingOdds != null` the rail
  // renders an "X → Y" delta on the selection card and replaces the
  // Place-bet button with an explicit accept step so the user opts in
  // to the new price before submitting.
  pendingOdds?: string | null;
  pendingProbability?: string | null;
  homeTeam: string;
  awayTeam: string;
  marketLabel: string;       // human display: "Match Winner", "Map Winner — Map 1"
  outcomeLabel: string;      // e.g. team name or "Map 1 winner"
  sportSlug: string;
  // Set when the leg was picked from a ZillaFlash boosted offer. The
  // engine in services/api/src/modules/zillaflash re-validates the id +
  // boosted price at POST /bets and shaves 2 s off the live-bet
  // acceptance delay when the offer is a live one. Unknown / expired
  // offer ids 400 the placement — the slip refreshes the price.
  zillaFlashOfferId?: string;
}

export interface PlaceBetRequest {
  stakeMicro: string;        // bigint as string
  idempotencyKey: string;    // client-supplied UUID
  currency?: Currency;       // wallet to debit; defaults to USDC for compat
  /**
   * Optional explicit product. Inferred when absent: 1 leg → "single",
   * ≥ 2 → "combo". For tiple/tippot the client must send it explicitly;
   * the server reads each leg's probability from market_outcomes (never
   * trusts client-supplied values) and prices fresh.
   *
   * For "betbuilder" the client must include the `betBuilder` block
   * (sessionId + expectedOddsX10000 from /betbuilder/match/:id/quote).
   * Per-leg `odds` here are still informational; the ticket pays out at
   * the OBB session odds.
   */
  betType?: BetType;
  selections: Array<{
    marketId: string;
    outcomeId: string;
    odds: string;            // decimal odds as displayed at click time
    // Optional opt-in to the ZillaFlash boosted price for this leg.
    // The server re-validates id + boosted odds (within the engine's
    // ±0.01 tolerance) before debiting stake; mismatched → 400 and the
    // client refreshes. Set automatically by the slip when the leg was
    // added from a ZillaFlash card or chip — never plumbed by hand.
    zillaFlashOfferId?: string;
  }>;
  /**
   * BetBuilder placement payload. Required when betType="betbuilder".
   * The server re-validates the session via OBB SessionInfo before
   * debiting stake — if Oddin says "invalid" the placement is rejected
   * with `betbuilder_session_invalid` and the client must re-quote.
   */
  betBuilder?: {
    sessionId: string;
    /** Combined session odds × 10_000 — what Oddin returned at quote. */
    expectedOddsX10000: number;
    /** Selection IDs as Oddin returned them (round-trip key). */
    selectionIds: string[];
  };
  /**
   * Bettor opt-in for the live-bet acceptance delay window
   * (riskzilla_live_delay_config). When true, the bet-delay worker
   * re-prices the ticket at the current odds instead of rejecting with
   * `odds_drift_exceeded`. Single + combo only; the flag is ignored for
   * tiple / tippot / betbuilder because those products freeze their
   * pricing at placement on probabilities / session id, not the per-leg
   * published price. Suspended / inactive checks still reject regardless.
   */
  acceptOddsChanges?: boolean;
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
  /**
   * Bettor opt-in for re-pricing during the live-bet acceptance delay
   * window. Surfaced so the bet-history UI can flag tickets accepted at
   * a different price than placed (the worker also overwrites
   * `oddsAtPlacement` on each selection in that case, so the user can
   * see the actual accepted leg odds inline).
   */
  acceptOddsChanges: boolean;
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
      // Human-readable market name resolved on the server from
      // `market_descriptions.name_template` with the market's specifiers
      // substituted (e.g. "Match winner", "Total rounds 12.5 - map 1",
      // "Team Astralis total kills 5.5"). Empty string when the
      // upstream description row is missing — callers should fall back
      // to "Market #<providerMarketId>" or just omit.
      marketName: string;
      // Human-readable outcome name from `market_outcomes.name`
      // (Oddin's resolved label after specifier substitution, e.g.
      // "LargadosyPelados", "Over 1.5", "Map 1"). Empty string when
      // the upstream outcome row was removed.
      outcomeName: string;
      // Live state of the underlying match + outcome, refreshed every
      // time /bets is read. The bet-history UI uses these to render a
      // "current odds" comparison beside the placement odds for legs
      // whose match hasn't started yet (prematch drift indicator). Null
      // when the upstream row was hard-deleted (rare, e.g. after a
      // recovery flush of an orphan market).
      matchStatus: "not_started" | "live" | "closed" | "cancelled" | "suspended";
      currentOdds: string | null;
      currentlyActive: boolean;
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
