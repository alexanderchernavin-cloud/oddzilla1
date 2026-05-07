// Shared API contract for the Community surface (Phase 10).
// Keep in lockstep with services/api/src/modules/community/*.

import type { Currency } from "./currencies.js";
import type { TicketStatus, BetType } from "./bets.js";

// ─── Profile ────────────────────────────────────────────────────────────────

// One unlocked achievement on the public profile. Catalog metadata
// (title / description / icon) is denormalised into the response so
// the web client can render without a second roundtrip.
export interface CommunityAchievement {
  id: string;
  title: string;
  description: string;
  icon: string; // lucide-icon slug
  unlockedAt: string; // ISO-8601
}

// Public profile shape — what /community/users/:nickname/profile returns.
// Stats are scoped per currency (Decision D4 in docs/COMMUNITY_PLAN.md).
// The `is_ai` flag is intentionally absent from every API response.
export interface CommunityProfile {
  nickname: string;
  bio: string | null;
  // Equipped avatar URL — server-resolved, already accounts for the
  // /avatars/... static path vs /community/avatars/:slug/image
  // upload path. NULL when the user hasn't picked one; UI falls back
  // to a monogram of the nickname.
  avatarUrl: string | null;
  joinedAt: string; // ISO-8601
  stats: {
    currency: Currency;
    settledTickets: number;
    wins: number;
    winRatePct: number; // 0–100, integer
    roiPct: number; // signed, integer
    badgeCount: number;
  };
  // Unlocked badges in display order (sort_order then unlocked_at).
  // Cross-currency — badges live on the user, not the currency, so a
  // profile carries the same achievements regardless of the
  // ?currency= query param.
  achievements: CommunityAchievement[];
}

// Self-view returned by /community/me. Includes editable fields (the
// public profile shape never returns `ticketsPublic` since the public
// surface only lists publicly-visible users in the first place).
export interface CommunityMe {
  ticketsPublic: boolean;
  nickname: string | null;
  bio: string | null;
  // Equipped avatar template id (raw FK) plus the resolved URL.
  // The UI uses templateId to highlight the active row in the
  // picker; avatarUrl renders the circle in the topbar.
  avatarTemplateId: string | null;
  avatarUrl: string | null;
}

// PATCH /community/me/visibility
export interface CommunityVisibilityRequest {
  ticketsPublic: boolean;
}

// PATCH /community/me/profile — both fields optional, but at least one
// must be present. The API rejects an empty patch with no_changes.
export interface CommunityProfileRequest {
  nickname?: string | null;
  bio?: string | null;
}

// ─── Feed (Phase 10.2) ──────────────────────────────────────────────────────

// One card on the community feed. Money fields are decimal strings
// (matching the rest of the codebase — bigint never serialised as
// Number). Sport ids match catalog sports for the icon lookup.
//
// Two flavours coexist in the same type:
//   • status='accepted' — Recent tab; the bet is in-flight on a still-
//     bettable match. `payoutMicro` is the *potential* payout (stake ×
//     totalOdds frozen at placement). `at` is the placed-at time.
//   • status='settled' / 'cashed_out' / 'voided' — Best Wins tab and
//     per-user history. `payoutMicro` is the actual payout.
//     `at` is the settled-at time.
// The frontend reads `status` to decide which presentation to use.
export interface CommunityTicketSummary {
  ticketId: string;
  nickname: string;
  bio: string | null;
  currency: Currency;
  status: Extract<
    TicketStatus,
    "accepted" | "settled" | "cashed_out" | "voided"
  >;
  betType: BetType;
  stakeMicro: string;
  payoutMicro: string;
  // Profit in micro units. For accepted tickets this is the
  // *potential* profit (potentialPayout − stake) so the Recent tab
  // can show "to win" parity with the Best Wins payout label. For
  // settled / cashed_out / voided it's the realised profit; can be
  // negative on cashed_out where the offer landed below stake.
  // String to preserve bigint precision over the wire — the Big
  // Wins threshold check happens server-side, this is presentation.
  profitMicro: string;
  totalOdds: string; // 4-decimal string
  numLegs: number;
  sportIds: number[];
  // Number of times this ticket has been used as the source of a
  // /community/copy call. Drives the Most Copied sort. Always 0 on
  // accepted tickets (the counter only ever increments on the
  // settled projection row). See migration 0033 for the rationale.
  inspirationCount: number;
  // Bettor's equipped avatar URL, server-resolved. NULL falls back
  // to a monogram of the nickname in the card chrome.
  avatarUrl: string | null;
  // True when the ticket's profit (payout − stake) clears the
  // per-currency Big Win threshold. Server-computed so the UI never
  // re-implements the threshold rule and operators can tune the
  // floor without a frontend deploy. Always false on accepted /
  // voided tickets; only ever true on a real win.
  isBigWin: boolean;
  // ISO-8601. For accepted tickets this is the placed-at time; for
  // settled/cashed_out/voided it's the settled-at time. The two are
  // collapsed into one field because the storefront only ever needs
  // "when did this card become its current state" for relative-time
  // formatting.
  at: string;
}

export interface CommunityFeedResponse {
  tickets: CommunityTicketSummary[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface CommunityUserTicketsResponse {
  nickname: string;
  tickets: CommunityTicketSummary[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// POST /admin/community/backfill — operator-triggered idempotent sweep
// that projects every missing settled / cashed_out ticket. Safe to
// re-run; ON CONFLICT DO UPDATE keeps existing rows in sync.
export interface CommunityBackfillResponse {
  scanned: number; // tickets considered (settled or cashed_out)
  upserted: number; // rows actually written or updated
}

// ─── Copy-to-bet (Phase 10.3) ───────────────────────────────────────────────

// POST /community/copy/:communityTicketId — returns a prefill payload.
// Each selection is shaped exactly like the web bet-slip's
// SlipSelection so the client can forward it via the existing
// `add()` API without reshaping. POST /bets re-validates everything
// at placement time, so the `odds` here is the source ticket's
// placement-time odds — the slip rail surfaces drift before the user
// confirms.
export interface CommunityCopySelection {
  matchId: string; // BIGINT as string
  marketId: string; // BIGINT as string
  outcomeId: string;
  odds: string;
  homeTeam: string;
  awayTeam: string;
  marketLabel: string;
  outcomeLabel: string;
  sportSlug: string;
  // True when the underlying market is currently `status=1` and the
  // match hasn't started or finished. UX hint only — POST /bets
  // re-validates at placement.
  available: boolean;
}

export interface CommunityCopyResponse {
  // The original ticket's currency. The web client warns on a
  // mismatch (e.g. "this ticket was OZ; your slip is USDT") rather
  // than auto-switching, since the user's current slip may already
  // contain other selections.
  currency: Currency;
  betType: BetType;
  selections: CommunityCopySelection[];
  // Whether at least one selection is currently `available`. The web
  // client uses this to decide between "Add to slip" and a soft
  // warning state.
  anyAvailable: boolean;
}

// ─── Errors (community-specific codes) ──────────────────────────────────────

// Returned as ApiErrorBody.error from the community endpoints.
export type CommunityErrorCode =
  | "nickname_taken" // 409
  | "nickname_invalid" // 400 — malformed or wrong length
  | "profile_not_public" // 404 — user exists but tickets_public = false
  | "no_changes"; // 400 — patch with no fields set
