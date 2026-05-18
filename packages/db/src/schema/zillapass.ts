// ZillaPass — quest / battle-pass tables. See migration 0060.
//
// `zillapassTasks` is the admin-curated catalog. `zillapassUserProgress`
// is per-user, per-period progress. `zillapassUserState` carries the
// user's level / xp / streak (one row per user, lazily created).
//
// Progress is not yet auto-incremented by any service — this PR ships
// the schema + admin CRUD + read-only user surfaces. The increment
// hooks for each predicate key land in a follow-up once the product
// team locks the predicate vocabulary.

import {
  pgTable,
  pgEnum,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  date,
  jsonb,
  uuid,
  index,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";

export const zillapassPeriodEnum = pgEnum("zillapass_period", [
  "daily",
  "weekly",
  "season",
]);

export const zillapassTasks = pgTable(
  "zillapass_tasks",
  {
    id: serial().primaryKey(),
    slug: text().notNull().unique(),
    title: text().notNull(),
    description: text(),
    targetCount: integer("target_count").notNull(),
    predicateKey: text("predicate_key").notNull(),
    period: zillapassPeriodEnum().notNull().default("daily"),
    // Stage number. Users only see tasks where `set_number` matches
    // their current_set_number; they advance one UTC day after
    // completing the set. Added by migration 0064.
    setNumber: integer("set_number").notNull().default(1),
    rewardKind: text("reward_kind"),
    rewardPayload: jsonb("reward_payload"),
    // Optional intra-app deep-link the storefront renders as a CTA on
    // the task card. Path-relative (starts with `/`), not a full URL —
    // see migration 0066. Lets admins point a task at the surface where
    // its predicate fires (e.g. `profile_complete` → /account/community)
    // without coupling the renderer to predicate vocabulary.
    ctaHref: text("cta_href"),
    ctaLabel: text("cta_label"),
    active: boolean().notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    setActiveSortIdx: index("zillapass_tasks_set_active_sort_idx").on(
      table.setNumber,
      table.active,
      table.sortOrder,
      table.id,
    ),
    targetCountPositive: check(
      "zillapass_tasks_target_count_positive",
      sql`${table.targetCount} > 0`,
    ),
    setNumberMin: check(
      "zillapass_tasks_set_number_min",
      sql`${table.setNumber} >= 1`,
    ),
  }),
);

export const zillapassUserProgress = pgTable(
  "zillapass_user_progress",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    taskId: integer("task_id")
      .notNull()
      .references(() => zillapassTasks.id, { onDelete: "cascade" }),
    periodStart: date("period_start").notNull(),
    currentCount: integer("current_count").notNull().default(0),
    // Set-shaped progress detail. Predicates that need to count
    // *distinct* items (e.g. 5 different sports) maintain a set here;
    // counter-only predicates leave it `{}`. Added by migration 0061.
    progressState: jsonb("progress_state").notNull().default({}),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.taskId, table.periodStart] }),
    userPeriodIdx: index("zillapass_user_progress_user_period_idx").on(
      table.userId,
      table.periodStart,
    ),
    currentCountNonNegative: check(
      "zillapass_user_progress_count_non_negative",
      sql`${table.currentCount} >= 0`,
    ),
  }),
);

export const zillapassUserState = pgTable(
  "zillapass_user_state",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    level: integer().notNull().default(1),
    xp: integer().notNull().default(0),
    activeStreakDays: integer("active_streak_days").notNull().default(0),
    lastActiveDate: date("last_active_date"),
    // Per-user stage (migration 0064). Defaults to 1; advances one UTC
    // day after the user completes every task in `current_set_number`.
    currentSetNumber: integer("current_set_number").notNull().default(1),
    // Stamped to TODAY (UTC) by the writer when the user completes
    // every active task in their current set. Cleared on advancement.
    lastSetCompletedDate: date("last_set_completed_date"),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    levelMin: check("zillapass_user_state_level_min", sql`${table.level} >= 1`),
    xpNonNegative: check(
      "zillapass_user_state_xp_non_negative",
      sql`${table.xp} >= 0`,
    ),
    streakNonNegative: check(
      "zillapass_user_state_streak_non_negative",
      sql`${table.activeStreakDays} >= 0`,
    ),
    currentSetMin: check(
      "zillapass_user_state_current_set_min",
      sql`${table.currentSetNumber} >= 1`,
    ),
  }),
);

export type ZillapassTask = typeof zillapassTasks.$inferSelect;
export type ZillapassUserProgress = typeof zillapassUserProgress.$inferSelect;
export type ZillapassUserState = typeof zillapassUserState.$inferSelect;
