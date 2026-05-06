// Shared API contract for the Community surface (Phase 10).
// Keep in lockstep with services/api/src/modules/community/*.

import type { Currency } from "./currencies.js";
import type { TicketStatus, BetType } from "./bets.js";

// ─── Profile ────────────────────────────────────────────────────────────────

// Public profile shape — what /community/users/:nickname/profile returns.
// Stats are scoped per currency (Decision D4 in docs/COMMUNITY_PLAN.md).
// The `is_ai` flag is intentionally absent from every API response.
export interface CommunityProfile {
  nickname: string;
  bio: string | null;
  joinedAt: string; // ISO-8601
  stats: {
    currency: Currency;
    settledTickets: number;
    wins: number;
    winRatePct: number; // 0–100, integer
    roiPct: number; // signed, integer
    badgeCount: number;
  };
}

// Self-view returned by /community/me. Includes editable fields (the
// public profile shape never returns `ticketsPublic` since the public
// surface only lists publicly-visible users in the first place).
export interface CommunityMe {
  ticketsPublic: boolean;
  nickname: string | null;
  bio: string | null;
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
export interface CommunityTicketSummary {
  ticketId: string;
  nickname: string;
  bio: string | null;
  currency: Currency;
  status: Extract<TicketStatus, "settled" | "cashed_out" | "voided">;
  betType: BetType;
  stakeMicro: string;
  payoutMicro: string;
  totalOdds: string; // 4-decimal string
  numLegs: number;
  sportIds: number[];
  settledAt: string; // ISO-8601
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
