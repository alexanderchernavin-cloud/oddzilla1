// WebSocket message types exchanged between ws-gateway and browsers.

import type { LiveChatBroadcastFrame } from "./live-chat.js";

export interface WsOddsUpdate {
  type: "odds";
  matchId: string; // bigint as string
  marketId: string;
  providerMarketId: number;
  specifiers: Record<string, string>;
  status: number;
  outcomes: Array<{
    outcomeId: string;
    odds: string; // decimal string to preserve precision
    active: boolean;
  }>;
  ts: number; // ms since epoch
}

export interface WsMatchStatus {
  type: "match_status";
  matchId: string;
  status: "not_started" | "live" | "closed" | "cancelled" | "suspended";
  liveScore?: unknown;
}

// Live-score frame published by feed-ingester on every odds_change that
// also carries a sport_event_status block. The wire shape is fixed by
// services/feed-ingester/internal/bus/redis.go `PublishLiveScore` — keep
// this type in sync with that publisher.
//
// The match-state watcher in services/api subscribes to this channel,
// detects deltas (score increases, status transitions per Oddin spec
// §2.4.1.2 codes {0,1,4,5}) and emits chat system messages.
export interface WsLiveScore {
  type: "score";
  matchId: string;
  // Verbatim payload from matches.live_score (jsonb). The watcher only
  // reads home / away / status / matchStatusCode; the rest is for the
  // storefront live-scoreboard widget.
  liveScore: WsLiveScorePayload;
}

export interface WsLiveScorePayload {
  home?: number | null;
  away?: number | null;
  // Oddin §2.4.1.2 codes: 0=not_started, 1=live, 4=closed, 5=cancelled.
  // Anything else is undocumented and treated as "no transition".
  status?: number | null;
  matchStatusCode?: number | null;
  currentMap?: number | null;
  // The full payload may include scoreboard / periods / updatedAt; the
  // chat watcher does not depend on those, so we leave them
  // unstructured rather than restating the entire shape.
  [key: string]: unknown;
}

export interface WsTicketUpdate {
  type: "ticket";
  ticketId: string;
  status: "pending_delay" | "accepted" | "rejected" | "settled" | "voided";
  rejectReason?: string;
}

// Market-level status frame. Published on `odds:match:{matchId}` whenever
// a market's `markets.status` column changes — by feed-ingester (every
// odds_change, bet_stop blanket, suspend-before-recover flush) and by
// settlement (settle → -3, cancel → -4, rollbacks). Outcome ticks alone
// can't carry this because the publisher's `active` flag mirrors
// `<outcome active>`, which Oddin keeps at "1" while shipping the last
// price on a suspended market — the rail then thinks the market is open
// until placement is rejected with `market_not_active`.
//
// The storefront merges these into its rendered market.status so the
// "is bettable" predicate can lock terminal statuses (0/-3/-4)
// immediately and unlock when Oddin reactivates (back to 1).
export interface WsMarketStatus {
  type: "marketStatus";
  matchId: string;
  marketId: string;
  // Mirrors the `markets.status` smallint enum:
  //   1 active, 0 deactivated, -1 suspended, -2 handover,
  //   -3 settled, -4 cancelled.
  status: number;
  ts: number; // ms since epoch
}

export type WsServerMessage =
  | WsOddsUpdate
  | WsMatchStatus
  | WsLiveScore
  | WsTicketUpdate
  | WsMarketStatus
  | LiveChatBroadcastFrame;

export interface WsSubscribeRequest {
  type: "subscribe";
  matchIds?: string[];
  tournamentIds?: string[];
  // When true, the (un)subscribe operation targets the live chat
  // fan-out dimension (chat:match:{id}) instead of the default odds
  // fan-out (odds:match:{id}). The two dimensions are independent —
  // a client that wants both sends two messages. Defaults to false
  // so existing odds-only clients (admin / dashboard) keep their
  // behaviour unchanged.
  chat?: boolean;
}

export interface WsUnsubscribeRequest {
  type: "unsubscribe";
  matchIds?: string[];
  tournamentIds?: string[];
  // Mirrors WsSubscribeRequest.chat — targets the chat dimension
  // independently of the odds dimension.
  chat?: boolean;
}

export type WsClientMessage = WsSubscribeRequest | WsUnsubscribeRequest;
