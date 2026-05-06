// Shared API contract for the Community surface (Phase 10).
// Keep in lockstep with services/api/src/modules/community/*.

import type { Currency } from "./currencies.js";

// ─── Profile ────────────────────────────────────────────────────────────────

// Public profile shape — what /community/users/:nickname/profile returns.
// Stats are scoped per currency (Decision D4 in docs/COMMUNITY_PLAN.md).
// The `is_ai` flag is intentionally absent from every API response.
export interface CommunityProfile {
  nickname: string;
  bio: string | null;
  joinedAt: string; // ISO-8601
  // Per-currency stats. Phase 10.1 returns zero-stats placeholders;
  // Phase 10.2 backfills these from `community_tickets` aggregates.
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

// ─── Errors (community-specific codes) ──────────────────────────────────────

// Returned as ApiErrorBody.error from the community endpoints.
export type CommunityErrorCode =
  | "nickname_taken" // 409
  | "nickname_invalid" // 400 — malformed or wrong length
  | "profile_not_public" // 404 — user exists but tickets_public = false
  | "no_changes"; // 400 — patch with no fields set
