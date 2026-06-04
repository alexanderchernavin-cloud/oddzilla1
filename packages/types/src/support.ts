// Shared support-chat types. Lives in packages/types so the api routes
// and the storefront widget agree on the wire shape.

export type SupportSenderKind = "user" | "admin" | "system";

export type SupportThreadStatus = "open" | "closed";

/** Per-file caps. Mirrored in the API plugin limits AND the
 * support_attachments CHECK constraint. Bump all three together. */
export const SUPPORT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const SUPPORT_ATTACHMENT_MAX_PER_MESSAGE = 5;

/** Open MIME — any browser-supplied content type is accepted. The
 * byte-serve route pins `Content-Disposition: attachment` plus
 * `X-Content-Type-Options: nosniff`, so every download is a save-to-
 * disk action and the browser cannot sniff its way into rendering a
 * disguised script. Inline image preview in the chat bubble is gated
 * on `contentType.startsWith("image/")`, which is a render-side
 * choice — not a security boundary. */
export type SupportAttachmentMime = string;

export interface SupportAttachment {
  id: string;
  filename: string;
  contentType: SupportAttachmentMime;
  sizeBytes: number;
  /** Byte-serve URL. Storefront + admin clients render image content
   * types as inline previews and everything else as a download link.
   * The route gates access by thread ownership (bettor) or
   * `support`/`admin` role (operator). */
  url: string;
}

export interface SupportMessage {
  id: string;
  threadId: string;
  senderKind: SupportSenderKind;
  /** UUID of the user (bettor or operator) who posted. NULL for
   * system messages (e.g. "Thread closed by support"). */
  senderUserId: string | null;
  /** Display name for the operator-side (admin nickname or "Support"
   * fallback) so the storefront can render a friendly badge without
   * a separate user-info lookup. NULL for bettor-sent / system rows. */
  senderName?: string | null;
  body: string;
  /** ISO 8601. */
  createdAt: string;
  /** Files attached to this message. Empty array on text-only messages. */
  attachments: SupportAttachment[];
  /** True when the Gemma assistant authored this reply (sender_kind is
   * still 'admin' + the dedicated AI support user). The admin UI badges
   * it; the storefront renders it as a normal support reply. */
  viaAi?: boolean;
}

export interface SupportThread {
  id: string;
  userId: string;
  status: SupportThreadStatus;
  subject: string | null;
  unreadUser: number;
  unreadAdmin: number;
  /** ISO 8601. */
  lastMessageAt: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601 or null when status='open'. */
  closedAt: string | null;
}

/** Response of `GET /support/me/thread`. Returns null only when the
 * user has never posted (no thread exists yet). */
export interface SupportMyThreadResponse {
  thread: SupportThread | null;
  messages: SupportMessage[];
}

/** WS frame the api publishes on the `user:{userId}` Redis channel
 * after a bettor or operator posts. Fan-out by ws-gateway. The
 * floating widget listens for these to refresh without polling. */
export interface SupportMessageFrame {
  type: "support_message";
  threadId: string;
  message: SupportMessage;
  /** Latest unread counter for the bettor side (i.e. messages from
   * admin/system the bettor hasn't acked). Mirrors what
   * `GET /support/me/thread` returns so the widget badge can update
   * without an extra round-trip. */
  unreadUser: number;
}

/** Admin-side summary returned by the inbox list. */
export interface AdminSupportThreadSummary {
  id: string;
  userId: string;
  userEmail: string;
  userNickname: string | null;
  status: SupportThreadStatus;
  subject: string | null;
  unreadAdmin: number;
  unreadUser: number;
  lastMessageAt: string;
  createdAt: string;
  closedAt: string | null;
  /** Migration 0080. The Gemma assistant auto-replies only while true.
   * Flipped false when a human "takes over" or the bot escalates. */
  aiHandling: boolean;
  /** ISO 8601 when ai_handling was last turned off, else null. */
  aiPausedAt: string | null;
  /** Body preview of the most recent message (any sender), trimmed
   * to 240 chars. Lets the inbox row show a one-liner without a
   * second query. */
  preview: string | null;
}

export interface AdminSupportThreadDetail {
  thread: AdminSupportThreadSummary;
  messages: SupportMessage[];
}

export interface AdminSupportUnreadCount {
  /** Sum of `unread_admin` over open threads — message-level. */
  unread: number;
  /** Count of distinct open threads with `unread_admin > 0`. The
   * sidebar prefers this since "5 conversations waiting" is more
   * actionable than "27 messages". */
  threads: number;
}

// ── AI support assistant (Gemma via LM Studio) ────────────────────────────
// The autonomous assistant runs on an operator PC (services/support-ai-bot),
// polls the server over outbound HTTPS, runs the local model, and posts
// replies back through /webhooks/support-ai/:secret. The types below are the
// wire contract shared by the API and that worker.

/** Fixed UUID of the seeded "Oddzilla Assistant" support user (migration
 * 0080). The API attributes bot replies to this id; the admin UI uses it to
 * badge AI-authored messages. Single source of truth so the seed + code agree. */
export const AI_SUPPORT_USER_ID = "00000000-0000-4000-8000-0000000a1b07";

/** One wallet balance, amounts pre-formatted as decimal strings by the
 * server (never raw micros) so the model can't fumble bigint math. */
export interface SupportAccountWalletFact {
  currency: string;
  available: string;
  locked: string;
}

/** One leg of a ticket, fully labelled by the server so the assistant can
 * explain exactly why a bet won, lost, or only partly paid. */
export interface SupportAccountTicketLegFact {
  /** Human market name, e.g. "Match winner", "Total rounds 24.5 - Map 1". */
  market: string;
  /** The outcome the bettor picked, e.g. "Astralis", "Over 24.5". */
  pick: string;
  odds: string;
  /** won | lost | void | half_won | half_lost | pending */
  result: string;
  /** "Home vs Away", or "" when the match row is gone. */
  match: string;
  sport: string;
  /** not_started | live | closed | cancelled | suspended | "" */
  matchStatus: string;
}

export interface SupportAccountTicketFact {
  id: string;
  status: string;
  betType: string;
  currency: string;
  stake: string;
  potentialPayout: string;
  actualPayout: string | null;
  placedAt: string;
  settledAt: string | null;
  /** Per-leg breakdown so the assistant can explain how the bet settled. */
  legs: SupportAccountTicketLegFact[];
}

export interface SupportAccountDepositFact {
  status: string;
  /** Formatted amount, or null when the intent has no parsed amount yet. */
  amount: string | null;
  confirmations: number;
  failureReason: string | null;
  submittedAt: string | null;
}

export interface SupportAccountWithdrawalFact {
  status: string;
  amount: string;
  fee: string;
  failureReason: string | null;
  requestedAt: string | null;
}

/** Server-computed, read-only snapshot of the asking bettor's own account.
 * The assistant may ONLY state facts present here — never invent figures.
 * Excludes all secrets/PII (addresses, tx hashes, IPs, password/refresh
 * hashes, admin-approver ids, bet_meta). */
export interface SupportAccountFacts {
  wallets: SupportAccountWalletFact[];
  tickets: SupportAccountTicketFact[];
  deposits: SupportAccountDepositFact[];
  withdrawals: SupportAccountWithdrawalFact[];
}

export interface SupportBotPendingMessage {
  sender: SupportSenderKind;
  viaAi: boolean;
  body: string;
  createdAt: string;
}

/** One unit of work for the assistant: an open, AI-handled thread with an
 * unanswered bettor message, plus the recent transcript and account facts. */
export interface SupportBotPendingThread {
  threadId: string;
  userId: string;
  subject: string | null;
  messages: SupportBotPendingMessage[];
  accountFacts: SupportAccountFacts;
}

export interface SupportBotPendingResponse {
  threads: SupportBotPendingThread[];
}

export interface SupportBotReplyRequest {
  text: string;
}

export interface SupportBotEscalateRequest {
  /** Internal note for the audit log (not shown to the bettor). */
  reason?: string;
  /** Optional bettor-facing holding message posted before handoff. */
  holdingMessage?: string;
}

/** Whether the assistant worker is currently online (heartbeating). Drives
 * the admin "Assistant online/offline" indicator. */
export interface SupportAiStatus {
  online: boolean;
  lastSeen: string | null;
}
