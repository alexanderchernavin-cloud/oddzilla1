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

// ─── Apply Same Play (Phase 10.4) ───────────────────────────────────────────
//
// Companion to copy-to-bet. Where /community/copy returns the literal
// legs of a settled ticket so the user can place them again, Apply
// Same Play takes a winning *single*-leg ticket and proposes upcoming
// matches the user could run the same play on. The frontend scores
// and ranks the candidates with same-play-scorer.ts; the backend's
// job is to return the originator's structured `play` and a pool of
// upcoming matches with the same provider_market_id + outcome_id
// available to bet.
//
// V1 scope (per Notion PRD "Big wins section", Open Question #3):
//   • Single-leg originators only. Combos return `combo_unsupported`.
//   • Same-sport candidates. Cross-sport is filtered server-side.
//   • Same provider_market_id + outcome_id on the candidate match.
//     This collapses the PRD's "Different market" branch to zero
//     candidates, which is acceptable for V1.
//   • Up to 30 candidates returned; the FE scores, ranks, and shows
//     the top 10.

// Coarse role inference from a moneyline-style price. Drives the
// "Both favorites" / "Different role" reason chips. The thresholds
// are heuristic — tuned against typical 2-way priced markets.
export type SamePlayRole = "favorite" | "underdog" | "even";

// Originator side fields the scorer needs that aren't on
// CommunityTicketSummary (which is a presentation shape, not an
// algorithm shape). Always keyed off a single-leg settled ticket.
export interface SamePlayOriginator {
  ticketId: string;
  currency: Currency;
  // Stake at placement, decimal string. Drives the Stake-mode
  // conversions client-side (Same / Target profit / Suggested).
  stakeMicro: string;
  // Odds at placement on the originator's selection — the reference
  // for the "Odds within N%" reason and Target-profit math.
  originalOdds: string;
  // Structured play. Composite key (providerMarketId, outcomeId) is
  // the "same market + selection" identity used by the candidate
  // query. specifiersJson is opaque metadata for the popover.
  play: {
    providerMarketId: number;
    outcomeId: string;
    outcomeLabel: string;
    marketLabel: string;
  };
  teams: {
    home: string;
    away: string;
    homeCompetitorId: number | null;
    awayCompetitorId: number | null;
    pickedSide: "home" | "away" | null;
    pickedRole: SamePlayRole;
  };
  sportId: number;
  sportName: string;
  // Tournament risk tier — Oddin's 1 = top, 3 = lower. Drives the
  // "Same tier" / "Lower tier league" reasons. Null when the tier
  // hasn't been backfilled yet; the scorer treats null as
  // tier-unknown and skips both reasons.
  leagueTier: number | null;
}

// One upcoming-match candidate. The FE scores it; the BE only
// guarantees a same-sport, same-(provider_market_id, outcome_id)
// match scheduled in the future.
export interface SamePlayCandidate {
  matchId: string; // BIGINT as string
  marketId: string; // BIGINT as string
  homeTeam: string;
  awayTeam: string;
  homeCompetitorId: number | null;
  awayCompetitorId: number | null;
  scheduledAt: string; // ISO-8601
  // Hours from "now" to kickoff at fetch time. Computed server-side
  // so the FE doesn't drift on clock skew. Negative values are
  // filtered out by the candidate query.
  hoursToKickoff: number;
  // True when the candidate market's status != 1 at fetch time.
  // FE renders the suspended row state and disables Copy.
  suspended: boolean;
  // Live price on the candidate's matching outcome.
  currentOdds: string;
  // Inferred role from currentOdds — same heuristic as the
  // originator's pickedRole. Drives the "Both favorites/underdogs"
  // reason chip.
  role: SamePlayRole;
  leagueTier: number | null;
  tournamentName: string;
  sportSlug: string;
}

export interface ApplySamePlayResponse {
  originator: SamePlayOriginator;
  candidates: SamePlayCandidate[];
}

// ─── Analyses (Phase 10.5) ──────────────────────────────────────────────────
//
// Pre-match editorial posts. Author attaches one of their own tickets
// as "skin in the game"; readers 👍 and copy. When the attached
// ticket settles, the analysis inherits the outcome.
//
// V1 quality gates (PRD: Quality rules + Reward formula):
//   • Body 100–5000 chars; perex ≤ 100
//   • Author must own the attached ticket
//   • Every leg of the attached ticket must reference the analysis's
//     match (single-match analyses only in V1)
//   • Match must be `not_started` at publish time (pre-match)
//   • Min odds 1.30 prematch on every leg (`recommendedMinRate`)
//   • One published analysis per (author, match) — UNIQUE partial idx
//   • 100/month/author rate limit (defined by client; flexes for
//     major events; expert tier grants +20)
//
// V1 reward stance: engagement-based ladder (cosmetic + status).
// Schema captures the data primitives (inspirations, copy
// attribution, settled outcome) so a future cash-share mechanic
// (Liga Stavok pattern) can layer on without migration.

export type AnalysisStatus = "draft" | "published" | "banned" | "voided";
export type AnalysisOutcome = "won" | "lost" | "void" | "cashed_out_void";

// Sort options for the cross-match feed. "Recommended" runs the
// 9-factor ranking from the Reward formula doc; the others are
// direct column orders.
export type AnalysisSort =
  | "recommended"
  | "recent"
  | "most_inspired"
  | "top_authors";

// One card on the analyses feed. Money fields stay as decimal strings
// to preserve bigint precision; counters are JS numbers (INT in
// Postgres).
export interface AnalysisSummary {
  id: string;
  authorId: string;
  authorNickname: string;
  authorAvatarUrl: string | null;
  authorWinRate: number | null; // 0–100, null until ≥3 settled analyses
  matchId: string; // BIGINT as string
  matchTitle: string; // "Team A vs Team B"
  sportId: number;
  sportName: string;
  sportSlug: string;
  // Match scheduling — match-page UI hides the "kickoff in N h" hint
  // once the match goes live; the feed uses it to render time-to-event
  // and the ranking algorithm reads it as a freshness signal.
  scheduledAt: string; // ISO-8601
  // Attached ticket summary. legCount is the number of selections;
  // totalOdds is the product (4 decimals). The ticket's own status
  // is exposed for the outcome-tracker badge — won / lost / void /
  // pending all render distinct chrome.
  ticketId: string;
  ticketTotalOdds: string;
  ticketLegCount: number;
  ticketStatus: Extract<TicketStatus, "accepted" | "settled" | "cashed_out" | "voided">;
  // Editorial fields.
  perex: string;
  body: string;
  status: AnalysisStatus;
  // Engagement.
  thumbsUpCount: number;
  inspirationCount: number;
  // True when the current viewer has 👍'd this analysis. NULL in
  // anonymous reads (the toggle is gated on auth on the frontend).
  viewerReacted: boolean | null;
  // Outcome inherited from the attached ticket. NULL until settled.
  outcome: AnalysisOutcome | null;
  publishedAt: string; // ISO-8601
  settledAt: string | null;
}

export interface AnalysisFeedResponse {
  analyses: AnalysisSummary[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// POST /community/analyses — author publishes. ticketId must be one
// of the author's own accepted tickets on the named match. The
// server re-validates every gate; the client doesn't need to know
// the regex/length rules upfront, but we mirror them so the editor
// can show inline errors before the round-trip.
export interface CreateAnalysisRequest {
  matchId: string;
  ticketId: string;
  perex: string;
  body: string;
}

// One row in the editor's ticket-selector. Server-pre-filtered to
// tickets that pass every gate POST /community/analyses enforces, so
// the editor never lights up Submit against a ticket that would 400.
export interface EligibleTicketSummary {
  ticketId: string;
  currency: Currency;
  stakeMicro: string;
  betType: BetType;
  legCount: number;
  totalOdds: string; // 4-decimal string
}

export interface EligibleTicketsResponse {
  tickets: EligibleTicketSummary[];
}

export interface AnalysisAuthorStats {
  nickname: string;
  authorId: string;
  // Full per-author win-loss record across settled analyses. Drives
  // the outcome-tracker badge on the profile page.
  totalAnalyses: number; // includes pending + settled
  settled: number;
  wins: number;
  losses: number;
  voids: number;
  // 0–100, integer. Null when settled < 3 (sample too small).
  winRatePct: number | null;
  // Sum of stake_micro from copies attributed to this author. Drives
  // "inspired turnover" in the ranking algorithm.
  inspiredTurnoverMicro: string;
  // 30/90/365-day ROI windows. The Reward formula keys expert status
  // off these; we surface them on the profile too. Null windows mean
  // no settled analyses in that horizon yet.
  roi30dPct: number | null;
  roi90dPct: number | null;
  roi365dPct: number | null;
}

// ─── Competitions (Phase 11) ────────────────────────────────────────────────
//
// Operator-curated prediction games over a set of matches. Bettors join,
// predict scores (or tip 1X2 for tipping-type comps), earn points per
// the scoring rules. Free entry only in V1 — the entry-free rule is
// enforced via the catalog (locked=true) rather than a top-level
// paid_disabled flag, leaving room for V2 paid comps without migration.
//
// References:
//   • PRD: Notion "Operator Dashboard - Competitions V1"
//   • Bettor UI: github.com/corwyn-com/competition-v2 + kollector PR #234
//   • Schema: migration 0043_community_competitions.sql

export type CompetitionStatus = "draft" | "scheduled" | "upcoming" | "live" | "ended";
export type CompetitionType = "prediction" | "tipping" | "challenge";
export type CompetitionMatchStatus = "upcoming" | "live" | "done";

// Sort options for the bettor home (CompetitionsHome). "featured"
// pulls the rotator pool; the others are direct column orders.
export type CompetitionSort =
  | "featured"
  | "starting_soon"
  | "most_joined"
  | "newest";

// Rule catalog. The 23-condition list from the PRD's rule catalog
// (scoring / entry / tiebreaker / timing / eligibility / prize). The
// catalog itself is product copy (TS land) — only the IDs cross the
// wire to the BE, which stores them as text in competition_rules.
export type CompetitionRuleCategory =
  | "scoring"
  | "entry"
  | "tiebreaker"
  | "timing"
  | "eligibility"
  | "prize";

// One assigned rule on a competition. value is opaque text — the
// catalog tells consumers how to parse it (point integers, ISO
// durations, integer caps). Server-rendered display strings live on
// CompetitionDetail.rules so the bettor surface doesn't need to ship
// the catalog itself.
export interface CompetitionRuleAssignment {
  ruleId: string;
  value?: string;
}

// One competition card on the bettor home (CompetitionListRow). Heavy
// detail fields (rules, full match list, leaderboard) load on the
// detail page; this shape covers list + featured + my-strip reads.
export interface CompetitionSummary {
  id: string;
  title: string;
  type: CompetitionType;
  status: CompetitionStatus;
  // Sport id + slug + name surfaced for the icon lookup. NULL for
  // multi-sport comps.
  sportId: number | null;
  sportSlug: string | null;
  sportName: string | null;
  league: string | null;
  // Schedule timestamps. The bettor surface uses launchAt for
  // "starts in N days" and matchStartAt for the kickoff countdown.
  launchAt: string; // ISO-8601
  betCloseAt: string;
  matchStartAt: string;
  stopShowAt: string;
  bannerUrl: string | null;
  thumbnailUrl: string | null;
  featured: boolean;
  // Display chips.
  markets: string[];
  // Denormalised counters surfaced for the list UI.
  participantCount: number;
  matchCount: number;
  // True when the viewer has joined this comp. NULL on anonymous
  // reads (the JoinPanel CTA renders only when authed).
  viewerJoined: boolean | null;
  // Viewer's current rank in this comp. NULL when not joined or
  // before any prediction has settled.
  viewerRank: number | null;
}

export interface CompetitionListResponse {
  competitions: CompetitionSummary[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// Detail-page payload. Includes the rendered rule strings (the BE
// renders catalog id+value into bettor-facing text) plus the heavy
// fields (description, full timestamps).
export interface CompetitionDetail extends CompetitionSummary {
  description: string;
  // Server-rendered rule display lines, e.g.
  // "Correct result: 3 points". The web client receives them ready
  // to render; the catalog itself stays in TS land.
  rules: string[];
  // The raw rule assignments — the admin surface uses these to seed
  // the wizard's Step 3 toggles when editing.
  ruleAssignments: CompetitionRuleAssignment[];
  // Audit metadata for the operator's own admin list. NULL on
  // bettor-facing responses (server strips it for non-owners).
  createdByNickname: string | null;
}

// One match row on the detail page's Matches tab. Mirrors
// competition-v2's CompetitionMatch verbatim with two adjustments:
//   • id is a string (BIGINT serialised) for parity with the rest of
//     the API
//   • viewer's prediction is inlined when present, so the matches
//     list and "your picks" rail render from one fetch
export interface CompetitionMatchRow {
  id: string;
  competitionId: string;
  // Optional FK to the catalog match; NULL on manually curated rows.
  matchId: string | null;
  teamA: string;
  teamB: string;
  league: string;
  kickoffAt: string; // ISO-8601
  status: CompetitionMatchStatus;
  scoreA: number | null;
  scoreB: number | null;
  suspended: boolean;
  cancelled: boolean;
  // Viewer's prediction on this match, if any. NULL when no
  // prediction or anonymous read.
  viewerPrediction: ViewerPrediction | null;
}

export interface ViewerPrediction {
  id: string;
  predictedScoreA: number;
  predictedScoreB: number;
  tip: "1" | "X" | "2" | null;
  placedAt: string;
  pointsAwarded: number | null;
  outcome: "correct" | "partial" | "wrong" | "void" | null;
  settledAt: string | null;
}

export interface CompetitionMatchesResponse {
  matches: CompetitionMatchRow[];
}

// One row on the leaderboard. Mirrors competition-v2's
// LeaderboardEntry with the additions oddzilla needs (avatarUrl,
// userId for profile links).
export interface CompetitionLeaderboardEntry {
  rank: number;
  userId: string;
  nickname: string;
  avatarUrl: string | null;
  points: number;
  correctCount: number;
  totalSettled: number;
  // 0–100, integer. NULL when totalSettled < 1.
  winRatePct: number | null;
  streak: number;
  longestStreak: number;
  // Last 5 settled outcomes (most-recent first), e.g.
  // ['correct', 'wrong', 'correct', 'void', 'correct']. Drives the
  // YourPositionPanel results pips.
  recentResults: ("correct" | "partial" | "wrong" | "void")[];
  // True for the requesting viewer's own row. The leaderboard view
  // pins the viewer above-the-fold even when their points rank far
  // down the list.
  isYou: boolean;
  // Movement since the prior settlement run. Positive = climbed,
  // negative = dropped, 0 = unchanged. Integer.
  rankDelta: number;
}

export interface CompetitionLeaderboardResponse {
  entries: CompetitionLeaderboardEntry[];
  // Total participant count — the leaderboard returns the top N + the
  // viewer's row, so the UI needs the full count for the "rank N of M"
  // label.
  totalParticipants: number;
  // The viewer's row when they're outside the returned page; NULL
  // when the viewer hasn't joined or is already in `entries`.
  viewerEntry: CompetitionLeaderboardEntry | null;
}

// POST /community/competitions/:id/join — idempotent. Returns the
// participant row the API just upserted.
export interface JoinCompetitionResponse {
  competitionId: string;
  joinedAt: string;
  alreadyJoined: boolean;
}

// POST /community/competitions/:id/predictions — submit / update one
// prediction. The API enforces the timing-lock-kickoff rule (no
// updates after the match's kickoff); double-POST returns the
// existing prediction (idempotent on (match, user)).
export interface CreatePredictionRequest {
  competitionMatchId: string;
  predictedScoreA: number;
  predictedScoreB: number;
  // Required for tipping-type comps; rejected for prediction-only
  // comps with `tip_not_allowed`.
  tip?: "1" | "X" | "2";
}

export interface CreatePredictionResponse {
  prediction: ViewerPrediction;
}

// Admin endpoints (operator surface on oddzilla itself; the
// community-dashboard repo carries the same shapes). All admin
// endpoints require the `admin` role on the caller.

export interface CreateCompetitionRequest {
  title: string;
  description?: string;
  type: CompetitionType;
  sportId?: number;
  league?: string;
  launchAt: string;
  betCloseAt: string;
  matchStartAt: string;
  stopShowAt: string;
  bannerUrl?: string;
  thumbnailUrl?: string;
  featured?: boolean;
  markets?: string[];
  rules: CompetitionRuleAssignment[];
  // Initial matches; the operator can add more later via
  // POST /admin/competitions/:id/matches.
  matches: AdminMatchInput[];
}

export interface AdminMatchInput {
  // Optional FK to a catalog match. When present, teamA/teamB/league/
  // kickoffAt are pulled from the catalog and the request fields are
  // ignored (the BE source-of-truths the catalog).
  matchId?: string;
  teamA: string;
  teamB: string;
  league?: string;
  kickoffAt: string;
  sortOrder?: number;
}

export interface UpdateCompetitionRequest {
  title?: string;
  description?: string;
  status?: CompetitionStatus;
  sportId?: number | null;
  league?: string | null;
  launchAt?: string;
  betCloseAt?: string;
  matchStartAt?: string;
  stopShowAt?: string;
  bannerUrl?: string | null;
  thumbnailUrl?: string | null;
  featured?: boolean;
  markets?: string[];
  // When set, replaces the rule set wholesale (not a patch). The
  // admin wizard always sends the full set.
  rules?: CompetitionRuleAssignment[];
}

export interface AdminCompetitionListResponse {
  competitions: CompetitionSummary[];
  // Counts per status for the admin tab strip.
  counts: {
    all: number;
    draft: number;
    scheduled: number;
    upcoming: number;
    live: number;
    ended: number;
  };
}

// ─── Errors (community-specific codes) ──────────────────────────────────────

// Returned as ApiErrorBody.error from the community endpoints.
export type CommunityErrorCode =
  | "nickname_taken" // 409
  | "nickname_invalid" // 400 — malformed or wrong length
  | "profile_not_public" // 404 — user exists but tickets_public = false
  | "no_changes" // 400 — patch with no fields set
  | "combo_unsupported" // 400 — Apply Same Play on a multi-leg ticket
  | "not_a_win" // 400 — Apply Same Play on a non-winning ticket
  // Analyses (Phase 10.5)
  | "match_not_eligible" // 400 — match is not pre-match (kickoff passed or status not 'not_started')
  | "ticket_not_owned" // 400 — ticketId doesn't belong to the caller
  | "ticket_match_mismatch" // 400 — ticket has legs on a different match
  | "ticket_not_eligible" // 400 — ticket isn't `accepted` or has odds < 1.30
  | "analysis_exists" // 409 — author already has a published analysis on this match
  | "analysis_immutable" // 400 — DELETE attempted post-kickoff
  | "perex_invalid" // 400 — wrong length
  | "body_invalid" // 400 — wrong length
  | "rate_limit_monthly" // 429 — author hit 100 analyses/month cap
  // Competitions (Phase 11)
  | "competition_not_found" // 404
  | "competition_not_open" // 400 — comp status not 'upcoming' (joins/predictions blocked)
  | "competition_full" // 409 — eligibility-max-participants rule reached
  | "prediction_locked" // 400 — kickoff has passed (timing-lock-kickoff)
  | "prediction_match_not_found" // 404 — competition_match_id not in this comp
  | "tip_required" // 400 — tipping comp without tip
  | "tip_not_allowed" // 400 — prediction-only comp with tip
  | "rules_locked" // 400 — admin tried to edit rules after a participant joined
  // Notifications (Phase 12)
  | "preference_invalid"; // 400 — empty patch or unknown key on /community/me/preferences

// ─── Notifications & preferences (Phase 12) ────────────────────────────────

// Mirrors the `notification_type` Postgres enum in
// 0044_community_notifications.sql. The web renderer keys icons,
// colors, and copy strings off this discriminator.
export type NotificationType =
  | "pick_copied"
  | "bet_inspired"
  | "new_follower"
  | "analysis_shared"
  | "leaderboard_move"
  | "competition_deadline"
  | "community_digest"
  | "challenge_completed"
  | "achievement_unlocked"
  | "level_up"
  | "loot_acquired"
  // Bet settlement (in-app bell). FCM mobile push uses its own
  // outbox path (push_notifications_outbox). See migration 0059.
  | "bet_won"
  | "bet_cashed_out"
  // Global Big Win fan-out. Fires to every non-bettor authenticated
  // user when a community ticket clears the per-currency Big Win
  // profit floor. Rides on the same pref_community_highlights toggle
  // as community_digest + analysis_shared. See migration 0067.
  | "big_win_landed";

// Per-type payload schemas. Stored in user_notifications.payload as
// JSONB; the FE renderer reads them by type. Keep these tight — they
// are denormalised snapshots, so additive changes are fine but renames
// would require a payload migration. NULL fields below mean "absent
// for that emit-site"; the renderer falls back gracefully.
export interface PickCopiedPayload {
  // Always present so the panel can render bold-actor + "copied your
  // bet" without a join. Snapshot-time nickname (a later rename
  // doesn't rewrite history).
  actorNickname: string;
  // Optional context line — match name + market. The renderer
  // displays it on the secondary line and falls back to a generic
  // "your bet" when absent.
  context?: string;
  // Source community ticket the actor copied. The deep-link points
  // here.
  sourceCommunityTicketId?: string;
}

export interface BetInspiredPayload {
  actorNickname: string;
  context?: string;
  sourceCommunityTicketId?: string;
}

export interface NewFollowerPayload {
  actorNickname: string;
}

export interface AnalysisSharedPayload {
  actorNickname: string;
  // The analysis the actor copied/applied from. Always present;
  // the renderer deep-links to /analyses/:id (via deep_link col).
  analysisId: string;
  // Match the analysis is on, for the secondary context line. Same
  // shape as PickCopiedPayload.context.
  context?: string;
}

export interface LeaderboardMovePayload {
  competitionId: string;
  competitionTitle: string;
  newRank: number;
  // Direction relative to last seen rank — drives "moved up to #N"
  // vs "dropped to #N" copy.
  direction: "up" | "down";
}

export interface CompetitionDeadlinePayload {
  competitionId: string;
  competitionTitle: string;
  // Hours until the bet-close deadline at the time of emission.
  // Renderer formats as "closes in 2 hours" / "closes in 30 minutes".
  hoursRemaining: number;
}

export interface CommunityDigestPayload {
  // Free-text headline ("Top wins this week"). Future digest
  // variants will add structured fields for trending picks.
  headline: string;
}

// Gamification rewards. XP/coins are integers (no fractional rewards
// in V1). cosmeticId is the avatars/cosmetic identifier when relevant.
export interface ChallengeCompletedPayload {
  challengeId: string;
  challengeTitle: string;
  xp?: number;
  coins?: number;
}

export interface AchievementUnlockedPayload {
  // achievement_definitions.id (the well-known catalog string).
  achievementId: string;
  achievementTitle: string;
  xp?: number;
}

export interface LevelUpPayload {
  newLevel: number;
  // Optional tier label ("Silver", "Gold"). Drives the celebratory
  // toast tier badge in V2.
  tierName?: string;
}

export interface LootAcquiredPayload {
  cosmeticId: string;
  cosmeticName: string;
  // 'common' | 'rare' | 'epic' | 'legendary' — opaque to the BE,
  // typed by the cosmetics catalog elsewhere.
  rarity: string;
}

// Bet settlement payloads. Money fields are decimal strings (e.g.
// "1250000" for 1.25 in display units at 6 micros/unit) so JSON
// doesn't lose precision past 2^53 on high-stake combo payouts —
// same convention as BetWonPushPayload in services/api/src/modules/
// push/render.ts. The renderer reads `currency` to pick a formatter.
export interface BetWonPayload {
  ticketId: string;
  betType: string;
  currency: string;
  stakeMicro: string;
  actualPayoutMicro: string;
  numLegs: number;
}

export interface BetCashedOutPayload {
  ticketId: string;
  betType: string;
  currency: string;
  stakeMicro: string;
  // The payout the user accepted from the cashout offer. Identical
  // shape to BetWonPayload.actualPayoutMicro so the renderer can
  // share most of its formatting logic.
  actualPayoutMicro: string;
  numLegs: number;
}

// Global Big Win fan-out payload. Recipient is anyone OTHER than the
// bettor; the bettor's own win lands as `bet_won` instead. Money
// fields are decimal strings (micro units) for the same JSON-precision
// reason BetWonPayload uses strings. Lockstep with the Go writer in
// services/settlement/internal/store/big_win.go.
//
// `actorNickname` follows the same shape as other actor-driven types
// (pick_copied, bet_inspired) so the notification panel renders the
// bettor in bold via the existing `item.actorNickname` path — no
// renderer branching needed. The Go writer skips fan-out entirely
// when the bettor's nickname is NULL or `tickets_public` is FALSE,
// so this is always a non-empty string in production rows.
export interface BigWinLandedPayload {
  ticketId: string;
  actorNickname: string;
  currency: string;
  stakeMicro: string;
  actualPayoutMicro: string;
}

export type NotificationPayload =
  | PickCopiedPayload
  | BetInspiredPayload
  | NewFollowerPayload
  | AnalysisSharedPayload
  | LeaderboardMovePayload
  | CompetitionDeadlinePayload
  | CommunityDigestPayload
  | ChallengeCompletedPayload
  | AchievementUnlockedPayload
  | LevelUpPayload
  | LootAcquiredPayload
  | BetWonPayload
  | BetCashedOutPayload
  | BigWinLandedPayload;

// One row in the GET /community/notifications response. The
// discriminated payload field is typed loosely (Record) at the
// transport layer — the renderer narrows by type. Strict per-type
// typing happens at the call site, not the wire.
export interface NotificationItem {
  id: string;
  type: NotificationType;
  // Snapshot-time actor nickname (denormalised in the payload). NULL
  // for system-emitted types (digest, level_up, loot_acquired).
  actorNickname: string | null;
  payload: Record<string, unknown>;
  // Optional path the panel routes to on click. NULL = no
  // navigation, just mark-read.
  deepLink: string | null;
  // Snapshot count for grouped items ("3 people copied your bet").
  // 1 for ungrouped rows.
  groupCount: number;
  read: boolean;
  createdAt: string; // ISO-8601
}

export interface NotificationListResponse {
  items: NotificationItem[];
  unreadCount: number;
  // Cursor-style pagination would slot in here if we ever need it.
  // V1 returns the most-recent N (50) and lets the panel decide.
}

// User-facing preferences shape. Returned by GET /community/me/preferences
// and accepted (partial) by PATCH /community/me/preferences. Mirrors
// the user_preferences table 1:1 with `sharePublicly` aliased onto
// users.tickets_public so the FE has one endpoint for both.
export interface NotificationPreferences {
  picksCopied: boolean;
  newFollowers: boolean;
  competitionUpdates: boolean;
  // Companion flag: TRUE when the user has explicitly toggled the
  // competition-updates switch. The FE uses it to disable the auto-
  // enable-on-join behavior that respects the user's prior choice.
  competitionUpdatesManuallySet: boolean;
  communityHighlights: boolean;
  achievementsRewards: boolean;
  // In-app bell coverage for bet_won + bet_cashed_out. Default TRUE
  // — see migration 0059_notif_bet_settlements.sql.
  betSettlements: boolean;
}

export interface PrivacyPreferences {
  // Aliased onto users.tickets_public; flipping this here is the
  // same write as PATCH /community/me/visibility. PRD: BetslipContext
  // sync.
  sharePublicly: boolean;
  showWinLossRecord: boolean;
  allowProfileDiscovery: boolean;
}

export interface PreferencesResponse {
  notifications: NotificationPreferences;
  privacy: PrivacyPreferences;
}

// Partial-update shape. Every key is optional; the API rejects an
// empty body with `preference_invalid`.
export interface PreferencesUpdateRequest {
  notifications?: Partial<NotificationPreferences>;
  privacy?: Partial<PrivacyPreferences>;
}

export interface MarkReadResponse {
  // Server-truth unread count after the mutation. Lets the bell
  // badge stay in sync without a follow-up GET.
  unreadCount: number;
}
