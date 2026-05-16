import { sql } from "drizzle-orm";
import {
  pgTable,
  bigserial,
  uuid,
  char,
  integer,
  bigint,
  numeric,
  text,
  timestamp,
  doublePrecision,
  primaryKey,
  index,
  uniqueIndex,
  check,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";
import {
  ticketStatusEnum,
  betTypeEnum,
  analysisStatusEnum,
  analysisOutcomeEnum,
  competitionStatusEnum,
  competitionTypeEnum,
  competitionMatchStatusEnum,
  notificationTypeEnum,
} from "../enums.js";
import { users } from "./users.js";
import { tickets } from "./tickets.js";
import { matches, sports } from "./catalog.js";

// Read-projection of settled tickets that drives the Community feed.
// Authoritative writer is services/settlement (Go) inside the
// SettleTicket / ReverseSettledTicket transaction; cashout (TS) writes
// inline; the admin backfill endpoint repairs any miss. See migration
// 0025_community_tickets.sql for the why.
export const communityTickets = pgTable(
  "community_tickets",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    ticketId: uuid()
      .notNull()
      .unique()
      .references(() => tickets.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    currency: char({ length: 4 }).notNull(),
    status: ticketStatusEnum().notNull(),
    betType: betTypeEnum().notNull(),
    stakeMicro: bigint({ mode: "bigint" }).notNull(),
    payoutMicro: bigint({ mode: "bigint" }).notNull().default(0n),
    totalOdds: numeric({ precision: 10, scale: 4 }).notNull(),
    numLegs: integer().notNull(),
    // INTEGER[] in postgres; drizzle's `.array()` chains under integer().
    sportIds: integer().array().notNull().default(sql`'{}'::integer[]`),
    settledAt: timestamp({ withTimezone: true }).notNull(),
    score: doublePrecision().notNull().default(0),
    // Number of times this ticket has been used as the source of a
    // /community/copy call. Drives the Most Copied sort on the Big
    // Wins tab; see migration 0033_community_big_wins.sql for the
    // denormalised-counter rationale and inflation analysis. The
    // projection writers (TS + Go) leave this column alone — the
    // route handler is the only writer.
    //
    // Audit SEC-L2: BIGINT (migration 0045) — the INT4 ceiling at
    // 2^31 is reachable in principle on a long-running viral
    // ticket; BIGINT pushes that out to 2^63 at one extra word per
    // row. `mode: "number"` keeps the API-facing payload a plain JS
    // number (the realistic upper bound is far below 2^53), so
    // callers don't have to deal with a bigint.
    inspirationCount: bigint({ mode: "number" }).notNull().default(0),
    // 0042_community_analyses.sql — copy attribution. NULL on organic
    // tickets and on copies from non-analysis sources (Big Win cards,
    // profile copies retain only `copiedFromPublisherId`). The pair
    // is the data primitive future cash-share rewards (Liga Stavok
    // pattern) would key off without a schema migration. The FK to
    // `analyses(id)` is declared in the SQL migration; we omit the
    // drizzle `.references()` here to avoid a circular import — the
    // migrator is hand-rolled, drizzle-kit isn't the source of truth.
    copiedFromAnalysisId: uuid(),
    copiedFromPublisherId: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("community_tickets_settled_idx").on(sql`${t.settledAt} DESC`),
    index("community_tickets_score_settled_idx").on(
      sql`${t.score} DESC`,
      sql`${t.settledAt} DESC`,
    ),
    index("community_tickets_user_settled_idx").on(
      t.userId,
      sql`${t.settledAt} DESC`,
    ),
    index("community_tickets_currency_settled_idx").on(
      t.currency,
      sql`${t.settledAt} DESC`,
    ),
    index("community_tickets_sport_idx").using("gin", t.sportIds),
    index("community_tickets_inspirations_idx").on(
      sql`${t.inspirationCount} DESC`,
      sql`${t.settledAt} DESC`,
    ),
    check("community_tickets_stake_pos", sql`${t.stakeMicro} > 0`),
    check("community_tickets_payout_nonneg", sql`${t.payoutMicro} >= 0`),
    check("community_tickets_num_legs_pos", sql`${t.numLegs} > 0`),
  ],
);

export type CommunityTicket = typeof communityTickets.$inferSelect;
export type NewCommunityTicket = typeof communityTickets.$inferInsert;

// Per-viewer dedup ledger for /community/copy. One row per
// (community_ticket, viewer) lifetime; written via INSERT … ON
// CONFLICT DO NOTHING inside the same transaction that bumps
// communityTickets.inspirationCount and emits `pick_copied`. See
// migration 0045_community_ticket_inspirations.sql for the audit-
// finding rationale (SEC-H2). The route handler is the only writer;
// readers are limited to the dedup INSERT itself.
export const communityTicketInspirations = pgTable(
  "community_ticket_inspirations",
  {
    communityTicketId: uuid()
      .notNull()
      .references(() => communityTickets.ticketId, { onDelete: "cascade" }),
    viewerUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    inspiredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.communityTicketId, t.viewerUserId] }),
    // Supports a future "tickets I copied" history surface without a
    // backfill. Cheap: the table is sparse compared to
    // community_tickets (one row per copy event).
    index("community_ticket_inspirations_viewer_idx").on(
      t.viewerUserId,
      sql`${t.inspiredAt} DESC`,
    ),
  ],
);

export type CommunityTicketInspiration =
  typeof communityTicketInspirations.$inferSelect;
export type NewCommunityTicketInspiration =
  typeof communityTicketInspirations.$inferInsert;

// ─── Projection tables (audit 0046) ─────────────────────────────────────────
//
// community_author_stats + community_user_stats kill four recompute-
// per-read aggregations:
//   • analyses feed's per-row author win-rate subquery (H1)
//   • analyses feed's top_authors ORDER BY (same subquery, twice/row)
//   • loadAuthorStats' SUM(stake_micro) over copied tickets (M6)
//   • loadProfileStats' SUM/COUNT over community_tickets (H3)
//
// See migration 0046_community_projection_tables.sql for the writer
// + read-side rewiring rationale.

export const communityAuthorStats = pgTable("community_author_stats", {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  settledAnalyses: integer().notNull().default(0),
  wonAnalyses: integer().notNull().default(0),
  // NULL until 3+ settled analyses. Writer recomputes on every
  // settlement bump; the read path joins and surfaces NULL straight
  // through the AnalysisSummary.authorWinRate contract.
  winRatePct: integer(),
  inspiredTurnoverMicro: bigint({ mode: "bigint" }).notNull().default(0n),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const communityUserStats = pgTable(
  "community_user_stats",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // TEXT not CHAR(4) — the migration intentionally stores raw
    // currency codes here. Callers from the API pass the trimmed
    // Currency type; the row lookup compares as a normal text scalar.
    currency: text().notNull(),
    settledCount: integer().notNull().default(0),
    winsCount: integer().notNull().default(0),
    totalStakeMicro: bigint({ mode: "bigint" }).notNull().default(0n),
    totalPayoutMicro: bigint({ mode: "bigint" }).notNull().default(0n),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.currency] })],
);

export type CommunityAuthorStats = typeof communityAuthorStats.$inferSelect;
export type NewCommunityAuthorStats = typeof communityAuthorStats.$inferInsert;
export type CommunityUserStats = typeof communityUserStats.$inferSelect;
export type NewCommunityUserStats = typeof communityUserStats.$inferInsert;

// ─── Achievements (Phase 10.4) ──────────────────────────────────────────────
//
// Hand-curated badge catalog and per-user unlock log. The
// (user_id, achievement_id) composite PK + ON CONFLICT DO NOTHING is
// the idempotency story for the unlock evaluator that runs after every
// projection write — see migration 0029_community_achievements.sql.

export const achievementDefinitions = pgTable("achievement_definitions", {
  id: text().primaryKey(),
  title: text().notNull(),
  description: text().notNull(),
  // lucide-icon slug; the web client falls back when the slug isn't in
  // apps/web/src/components/ui/icons.tsx.
  icon: text().notNull(),
  sortOrder: integer().notNull().default(0),
});

export const userAchievements = pgTable(
  "user_achievements",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    achievementId: text()
      .notNull()
      .references(() => achievementDefinitions.id),
    unlockedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.achievementId] }),
    index("user_achievements_user_idx").on(
      t.userId,
      sql`${t.unlockedAt} DESC`,
    ),
  ],
);

export type AchievementDefinition = typeof achievementDefinitions.$inferSelect;
export type UserAchievement = typeof userAchievements.$inferSelect;

// ─── Analyses (Phase 10.5) ──────────────────────────────────────────────────
//
// Pre-match editorial posts. The author attaches their own ticket as
// "skin in the game"; readers 👍 and copy. When the attached ticket
// settles, the analysis inherits the outcome. See migration
// 0042_community_analyses.sql for the full rationale.

export const analyses = pgTable(
  "analyses",
  {
    id: uuid().primaryKey().defaultRandom(),
    authorId: uuid()
      .notNull()
      .references(() => users.id),
    matchId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => matches.id),
    // Skin-in-the-game ticket. RESTRICT on delete — orphaning an
    // analysis would silently lie to readers about the author's
    // commitment.
    ticketId: uuid()
      .notNull()
      .references(() => tickets.id, { onDelete: "restrict" }),
    perex: text().notNull(),
    body: text().notNull(),
    status: analysisStatusEnum().notNull().default("published"),
    // Audit SEC-L2: BIGINT (migration 0045) — same rationale as
    // community_tickets.inspirationCount above; closes the slow
    // 2^31 overflow path on viral analyses.
    thumbsUpCount: bigint({ mode: "number" }).notNull().default(0),
    inspirationCount: bigint({ mode: "number" }).notNull().default(0),
    outcome: analysisOutcomeEnum(),
    settledAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Indexes mirror the migration. Partial indexes on status =
    // 'published' keep the planner's stats clean once banned/voided
    // rows accumulate.
    index("analyses_match_published_idx")
      .on(t.matchId, sql`${t.publishedAt} DESC`)
      .where(sql`${t.status} = 'published'`),
    index("analyses_inspirations_idx")
      .on(sql`${t.inspirationCount} DESC`, sql`${t.publishedAt} DESC`)
      .where(sql`${t.status} = 'published'`),
    index("analyses_thumbs_idx")
      .on(sql`${t.thumbsUpCount} DESC`, sql`${t.publishedAt} DESC`)
      .where(sql`${t.status} = 'published'`),
    index("analyses_published_at_idx")
      .on(sql`${t.publishedAt} DESC`)
      .where(sql`${t.status} = 'published'`),
    index("analyses_author_published_idx")
      .on(t.authorId, sql`${t.publishedAt} DESC`)
      .where(sql`${t.status} = 'published'`),
    index("analyses_ticket_id_idx").on(t.ticketId),
    check("analyses_perex_len", sql`char_length(${t.perex}) BETWEEN 1 AND 100`),
    check("analyses_body_len", sql`char_length(${t.body}) BETWEEN 100 AND 5000`),
    check("analyses_thumbs_nonneg", sql`${t.thumbsUpCount} >= 0`),
    check("analyses_inspirations_nonneg", sql`${t.inspirationCount} >= 0`),
  ],
);

export const analysisReactions = pgTable(
  "analysis_reactions",
  {
    analysisId: uuid()
      .notNull()
      .references(() => analyses.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    reactedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.analysisId, t.userId] })],
);

export type Analysis = typeof analyses.$inferSelect;
export type NewAnalysis = typeof analyses.$inferInsert;
export type AnalysisReaction = typeof analysisReactions.$inferSelect;

// ─── Competitions (Phase 11) ────────────────────────────────────────────────
//
// Operator-curated prediction games over a set of matches. Bettors join,
// predict scores (or tip 1X2 for tipping-type comps), earn points per
// the scoring rules. Free entry only in V1 (the entry-free rule is
// locked in the catalog rather than a paid_disabled flag, so V2 paid
// comps don't need a migration). See migration
// 0043_community_competitions.sql for the full rationale.

export const competitions = pgTable(
  "competitions",
  {
    id: uuid().primaryKey().defaultRandom(),
    title: text().notNull(),
    description: text().notNull().default(""),
    type: competitionTypeEnum().notNull(),
    status: competitionStatusEnum().notNull().default("draft"),
    // NULL = multi-sport; PRD says single-sport in V1 but the
    // "Start from Scratch" template lets the operator skip pre-publish.
    sportId: integer().references(() => sports.id),
    // Free text — some operator leagues (manual cups, cross-tournament
    // weeklies) won't exist in the catalog. Tightening to a tournaments
    // FK is a V2 concern.
    league: text(),
    launchAt: timestamp({ withTimezone: true }).notNull(),
    betCloseAt: timestamp({ withTimezone: true }).notNull(),
    matchStartAt: timestamp({ withTimezone: true }).notNull(),
    stopShowAt: timestamp({ withTimezone: true }).notNull(),
    bannerUrl: text(),
    thumbnailUrl: text(),
    featured: boolean().notNull().default(false),
    // Display chips on the detail page, e.g. ['1X2', 'correct-score'].
    markets: text().array().notNull().default(sql`'{}'::text[]`),
    // Denormalised counters bumped at API write time. See
    // community_tickets.inspirationCount for the precision-vs-
    // simplicity trade-off.
    participantCount: integer().notNull().default(0),
    matchCount: integer().notNull().default(0),
    createdBy: uuid().references(() => users.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Bettor list filtered by status + ordered by launch_at. Covers
    // every status-tab read on the home (All / Live / Upcoming /
    // Draft / Ended).
    index("competitions_status_launch_idx").on(
      t.status,
      sql`${t.launchAt} DESC`,
    ),
    // Featured rotator. Partial because most comps aren't featured;
    // bettors only ever see featured + currently-running ones.
    index("competitions_featured_idx")
      .on(sql`${t.launchAt} DESC`)
      .where(sql`${t.featured} = TRUE AND ${t.status} IN ('upcoming', 'live')`),
    // Operator's own admin list.
    index("competitions_created_by_idx")
      .on(t.createdBy, sql`${t.createdAt} DESC`)
      .where(sql`${t.createdBy} IS NOT NULL`),
    check("competitions_title_len", sql`char_length(${t.title}) BETWEEN 1 AND 200`),
    check("competitions_desc_len", sql`char_length(${t.description}) <= 2000`),
    check("competitions_participant_count_nonneg", sql`${t.participantCount} >= 0`),
    check("competitions_match_count_nonneg", sql`${t.matchCount} >= 0`),
    check("competitions_bet_close_before_match_start", sql`${t.betCloseAt} <= ${t.matchStartAt}`),
    check("competitions_match_start_before_stop", sql`${t.matchStartAt} <= ${t.stopShowAt}`),
  ],
);

// Rules catalog assignments. rule_id is the well-known catalog
// identifier from packages/types/src/community.ts (e.g.
// 'scoring-correct-result', 'entry-free'); value carries the
// configurable payload as text. The catalog itself lives in TS land
// because it's product-tuned copy, not data; the BE only needs the
// FK identifier + value.
export const competitionRules = pgTable(
  "competition_rules",
  {
    competitionId: uuid()
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    ruleId: text().notNull(),
    value: text(),
    sortOrder: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.competitionId, t.ruleId] }),
    index("competition_rules_competition_idx").on(t.competitionId, t.ruleId),
  ],
);

export const competitionMatches = pgTable(
  "competition_matches",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    competitionId: uuid()
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    // Optional FK to the catalog. NULL = manual match (admin typed
    // team names directly, no live odds wiring). When non-NULL,
    // settlement reads the final score from matches.score_*; when
    // NULL the operator enters scores in the admin UI.
    matchId: bigint({ mode: "bigint" }).references(() => matches.id, {
      onDelete: "set null",
    }),
    teamA: text().notNull(),
    teamB: text().notNull(),
    league: text().notNull().default(""),
    kickoffAt: timestamp({ withTimezone: true }).notNull(),
    status: competitionMatchStatusEnum().notNull().default("upcoming"),
    scoreA: integer(),
    scoreB: integer(),
    // Display-only flags from competition-v2 prototype. The operator
    // dashboard doesn't expose these in V1 — carrying them keeps the
    // UI faithful and lets a future admin field flip them without a
    // migration.
    suspended: boolean().notNull().default(false),
    cancelled: boolean().notNull().default(false),
    sortOrder: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Same catalog match cannot appear twice in one competition.
    // Manual rows (NULL match_id) are exempt via the partial WHERE.
    uniqueIndex("competition_matches_unique_idx")
      .on(t.competitionId, t.matchId)
      .where(sql`${t.matchId} IS NOT NULL`),
    index("competition_matches_kickoff_idx").on(t.competitionId, t.kickoffAt),
    index("competition_matches_match_id_idx")
      .on(t.matchId)
      .where(sql`${t.matchId} IS NOT NULL`),
    check("competition_matches_score_a_nonneg", sql`${t.scoreA} IS NULL OR ${t.scoreA} >= 0`),
    check("competition_matches_score_b_nonneg", sql`${t.scoreB} IS NULL OR ${t.scoreB} >= 0`),
    check(
      "competition_matches_scores_paired",
      sql`(${t.scoreA} IS NULL) = (${t.scoreB} IS NULL)`,
    ),
  ],
);

export const competitionParticipants = pgTable(
  "competition_participants",
  {
    competitionId: uuid()
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Aggregate stats. Authoritative writer is services/settlement
    // (Go); the API only ever sets these to 0 on join.
    points: integer().notNull().default(0),
    correctCount: integer().notNull().default(0),
    totalSettled: integer().notNull().default(0),
    streak: integer().notNull().default(0),
    longestStreak: integer().notNull().default(0),
    lastSettledAt: timestamp({ withTimezone: true }),
    // Audit 0045 — last 5 settled prediction outcomes, newest first.
    // Maintained by scoreMatchPredictions on every settle: it prepends
    // and truncates via (ARRAY[new] || old)[1:5]. Replaces a 50-row
    // correlated subquery on every leaderboard read.
    recentOutcomes: text()
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
  },
  (t) => [
    primaryKey({ columns: [t.competitionId, t.userId] }),
    // Leaderboard read. Compound index ordered by points DESC, with
    // longest_streak DESC as the deterministic tiebreaker.
    index("competition_participants_leaderboard_idx").on(
      t.competitionId,
      sql`${t.points} DESC`,
      sql`${t.longestStreak} DESC`,
    ),
    index("competition_participants_user_idx").on(
      t.userId,
      sql`${t.joinedAt} DESC`,
    ),
    check("competition_participants_points_nonneg", sql`${t.points} >= 0`),
    check("competition_participants_correct_nonneg", sql`${t.correctCount} >= 0`),
    check("competition_participants_total_nonneg", sql`${t.totalSettled} >= 0`),
    check("competition_participants_streak_nonneg", sql`${t.streak} >= 0`),
    check("competition_participants_longest_nonneg", sql`${t.longestStreak} >= 0`),
    check(
      "competition_participants_correct_le_total",
      sql`${t.correctCount} <= ${t.totalSettled}`,
    ),
  ],
);

export const competitionPredictions = pgTable(
  "competition_predictions",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    competitionId: uuid()
      .notNull()
      .references(() => competitions.id, { onDelete: "cascade" }),
    competitionMatchId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => competitionMatches.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    predictedScoreA: integer().notNull(),
    predictedScoreB: integer().notNull(),
    // '1' | 'X' | '2' for tipping comps; NULL for prediction-only
    // comps. The CHECK pins the shape; the API enforces per-type
    // that the right shape is sent.
    tip: char({ length: 1 }),
    placedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Settlement output. NULL until the underlying competition_match
    // settles. participant.points = SUM(points_awarded WHERE
    // settled).
    pointsAwarded: integer(),
    // 'correct' / 'partial' / 'wrong' / 'void' — derived from
    // per-rule scoring. TEXT not enum because the rule catalog can
    // introduce new outcome labels without a migration.
    outcome: text(),
    settledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    // One prediction per (match, user). UNIQUE not PK because the
    // BIGSERIAL id is the natural row identifier for inserts.
    uniqueIndex("competition_predictions_unique_idx").on(
      t.competitionMatchId,
      t.userId,
    ),
    index("competition_predictions_user_idx").on(t.competitionId, t.userId),
    // Settlement read: when a competition_match settles, find every
    // unsettled prediction on it.
    index("competition_predictions_settle_idx")
      .on(t.competitionMatchId)
      .where(sql`${t.settledAt} IS NULL`),
    check(
      "competition_predictions_score_a_nonneg",
      sql`${t.predictedScoreA} >= 0`,
    ),
    check(
      "competition_predictions_score_b_nonneg",
      sql`${t.predictedScoreB} >= 0`,
    ),
    check(
      "competition_predictions_tip_valid",
      sql`${t.tip} IS NULL OR ${t.tip} IN ('1', 'X', '2')`,
    ),
    check(
      "competition_predictions_points_nonneg",
      sql`${t.pointsAwarded} IS NULL OR ${t.pointsAwarded} >= 0`,
    ),
  ],
);

export type Competition = typeof competitions.$inferSelect;
export type NewCompetition = typeof competitions.$inferInsert;
export type CompetitionRule = typeof competitionRules.$inferSelect;
export type NewCompetitionRule = typeof competitionRules.$inferInsert;
export type CompetitionMatch = typeof competitionMatches.$inferSelect;
export type NewCompetitionMatch = typeof competitionMatches.$inferInsert;
export type CompetitionParticipant = typeof competitionParticipants.$inferSelect;
export type NewCompetitionParticipant = typeof competitionParticipants.$inferInsert;
export type CompetitionPrediction = typeof competitionPredictions.$inferSelect;
export type NewCompetitionPrediction = typeof competitionPredictions.$inferInsert;

// ─── Notifications & preferences (Phase 12) ─────────────────────────────────
//
// See migration 0044_community_notifications.sql for the schema-level
// rationale (why a separate prefs table, why read_at over a boolean,
// why group_key is a column not derived).

export const userPreferences = pgTable("user_preferences", {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  prefPicksCopied: boolean().notNull().default(true),
  prefNewFollowers: boolean().notNull().default(true),
  prefCompetitionUpdates: boolean().notNull().default(false),
  // Companion to prefCompetitionUpdates: did the user toggle it
  // explicitly? The competition-join handler only auto-enables when
  // this is FALSE — same shape as the V1 PRD's
  // `competitionUpdates_manuallySet`.
  prefCompetitionUpdatesSet: boolean().notNull().default(false),
  prefCommunityHighlights: boolean().notNull().default(true),
  prefAchievementsRewards: boolean().notNull().default(true),
  // Gates `bet_won` and `bet_cashed_out` (in-app bell only; FCM
  // mobile push uses its own outbox-side dispatch). Defaults TRUE
  // because settlement is a wallet-affecting event most users want
  // surfaced — see 0059_notif_bet_settlements.sql.
  prefBetSettlements: boolean().notNull().default(true),
  // V1 save-only — public profile + search will start consulting
  // these in V2 (PRD: V2 enforcement).
  privacyShowWinLossRecord: boolean().notNull().default(true),
  privacyAllowProfileDiscovery: boolean().notNull().default(true),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const userNotifications = pgTable(
  "user_notifications",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: notificationTypeEnum().notNull(),
    // Nullable: system-emitted types (community_digest, level_up,
    // loot_acquired) have no actor.
    actorId: uuid().references(() => users.id, { onDelete: "set null" }),
    payload: jsonb().notNull().default(sql`'{}'::jsonb`),
    deepLink: text(),
    groupKey: text(),
    groupCount: integer().notNull().default(1),
    readAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("user_notifications_user_created_idx").on(
      t.userId,
      sql`${t.createdAt} DESC`,
    ),
    index("user_notifications_user_unread_idx")
      .on(t.userId)
      .where(sql`${t.readAt} IS NULL`),
    index("user_notifications_group_idx")
      .on(t.userId, t.type, t.groupKey, sql`${t.createdAt} DESC`)
      .where(sql`${t.groupKey} IS NOT NULL`),
    check("user_notifications_group_count_pos", sql`${t.groupCount} >= 1`),
  ],
);

export type UserPreferences = typeof userPreferences.$inferSelect;
export type NewUserPreferences = typeof userPreferences.$inferInsert;
export type UserNotification = typeof userNotifications.$inferSelect;
export type NewUserNotification = typeof userNotifications.$inferInsert;
