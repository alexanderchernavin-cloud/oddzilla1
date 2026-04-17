// WebSocket message types exchanged between ws-gateway and browsers.

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

export interface WsTicketUpdate {
  type: "ticket";
  ticketId: string;
  status: "pending_delay" | "accepted" | "rejected" | "settled" | "voided";
  rejectReason?: string;
}

export type WsServerMessage = WsOddsUpdate | WsMatchStatus | WsTicketUpdate;

export interface WsSubscribeRequest {
  type: "subscribe";
  matchIds?: string[];
  tournamentIds?: string[];
}

export interface WsUnsubscribeRequest {
  type: "unsubscribe";
  matchIds?: string[];
  tournamentIds?: string[];
}

export type WsClientMessage = WsSubscribeRequest | WsUnsubscribeRequest;
