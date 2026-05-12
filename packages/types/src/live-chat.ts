// Live match chat — shared types for client + server.
// See Notion spec at notion.so/Live-match-chat-32e64f04f9b480d48b13d808dbce2366
// and migration 0045_live_chat.sql for the persistence contract.
//
// Reactions are typed enums (NOT emoji characters) per CLAUDE.md
// invariant 8: no emojis in code, UI text, logs, or comments. The
// client renders each ReactionKind via the design system's icon set.

export const REACTION_KINDS = [
  "goal",
  "miss",
  "redcard",
  "fire",
  "cry",
  "hundred",
] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];

export const PICK_OUTCOMES = ["home", "draw", "away"] as const;
export type PickOutcome = (typeof PICK_OUTCOMES)[number];

// System-event subkinds emitted by the match-state watcher. Free-text
// at the DB layer so new events extend without a migration; the
// shipping set is listed here for type safety in the UI switch.
export type SystemMessageKind =
  | "goal"
  | "half_time"
  | "full_time"
  | "kickoff"
  | "match_suspended"
  | "match_cancelled";

export interface LiveChatScoreSnapshot {
  home: number;
  away: number;
}

export interface LiveChatMatchSnapshot {
  score: LiveChatScoreSnapshot;
  clock: string; // "74'" | "HT" | "FT" | "" (pre-match)
  status: "not_started" | "live" | "halftime" | "fulltime" | "suspended";
}

export interface LiveChatUserMessage {
  id: string; // bigserial as string to keep JSON safe
  matchId: string;
  kind: "user";
  userId: string;
  nickname: string;
  avatarInitials: string; // computed server-side from nickname
  text: string;
  createdAt: string; // ISO timestamp
}

export interface LiveChatSystemMessage {
  id: string;
  matchId: string;
  kind: "system";
  systemKind: SystemMessageKind;
  text: string;
  payload: LiveChatMatchSnapshot | null;
  createdAt: string;
}

export type LiveChatMessage = LiveChatUserMessage | LiveChatSystemMessage;

export interface LiveChatCrowdPicks {
  home: number;
  draw: number;
  away: number;
  totalVotes: number;
}

export interface LiveChatBetPin {
  ticketId: string;
  // Raw outcome label from market_outcomes.name, e.g. "Arsenal" /
  // "Draw" / "Chelsea". Always present; the client falls back to
  // this string when pickedSide is null.
  outcomeLabel: string;
  oddsX10000: number;
  stakeMicro: string; // bigint-as-decimal-string (CLAUDE.md invariant 1)
  potentialWinMicro: string;
  currency: string;
  // Raw ticket lifecycle status from the tickets table.
  status: "pending" | "won" | "lost" | "void" | "cashed_out";
  // Derived from (providerMarketId, outcomeId) when the bet sits on
  // a recognised market shape (provider_market_id=1, i.e. match
  // winner, with Oddin outcome IDs "1" / "X" / "2"). Null when the
  // bet is on a market the UI can't score against the live state —
  // e.g. totals, BTTS, or any market whose outcome doesn't map to a
  // home/draw/away axis. The client uses this with the running
  // match snapshot to render "Winning" / "At risk" treatments
  // (Notion Epic 5).
  pickedSide: "home" | "draw" | "away" | null;
}

// Snapshot delivered on join_room. Reactions are ephemeral — not
// included here; clients render them as they arrive.
export interface LiveChatRoomState {
  matchId: string;
  match: LiveChatMatchSnapshot;
  viewerCount: number;
  // The reveal-on-vote rule: the server only populates `crowdPicks`
  // for users who have already submitted a pick. `myPick` lets the
  // client render the right UI state without an extra round-trip.
  myPick: PickOutcome | null;
  crowdPicks: LiveChatCrowdPicks | null;
  messages: LiveChatMessage[];
  // Null when the user has no open ticket on this match.
  betPin: LiveChatBetPin | null;
}

// --- Pub/sub frame payloads -------------------------------------------------
//
// What services/api publishes onto Redis channels:
//   chat:match:{matchId}  — fan-out events to every subscriber
//   chat:presence:{matchId} — viewer-count deltas (ws-gateway emits)
//
// ws-gateway forwards these payloads verbatim to subscribed clients.

export interface LiveChatMessageFrame {
  type: "chat_message";
  matchId: string;
  message: LiveChatMessage;
}

export interface LiveChatReactionFrame {
  type: "chat_reaction";
  matchId: string;
  userId: string;
  nickname: string;
  reaction: ReactionKind;
  // Client-supplied burst id so concurrent reactions don't collide in
  // animations. Server stamps it server-side to keep clocks honest.
  burstId: string;
}

export interface LiveChatPicksUpdateFrame {
  type: "chat_picks_update";
  matchId: string;
  crowdPicks: LiveChatCrowdPicks;
}

export interface LiveChatMatchUpdateFrame {
  type: "chat_match_update";
  matchId: string;
  match: LiveChatMatchSnapshot;
}

export interface LiveChatViewerCountFrame {
  type: "chat_viewer_count";
  matchId: string;
  viewerCount: number;
}

export type LiveChatBroadcastFrame =
  | LiveChatMessageFrame
  | LiveChatReactionFrame
  | LiveChatPicksUpdateFrame
  | LiveChatMatchUpdateFrame
  | LiveChatViewerCountFrame;
