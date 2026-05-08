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
  check,
} from "drizzle-orm/pg-core";
import {
  ticketStatusEnum,
  betTypeEnum,
  analysisStatusEnum,
  analysisOutcomeEnum,
} from "../enums.js";
import { users } from "./users.js";
import { tickets } from "./tickets.js";
import { matches } from "./catalog.js";

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
    inspirationCount: integer().notNull().default(0),
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
    thumbsUpCount: integer().notNull().default(0),
    inspirationCount: integer().notNull().default(0),
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
