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
import { ticketStatusEnum, betTypeEnum } from "../enums.js";
import { users } from "./users.js";
import { tickets } from "./tickets.js";

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
