// Per-bettor odds adjustment with cascade overrides (migration 0068).
//
// One row per (user, scope, ref). The cascade at catalog read / bet
// placement time resolves match > tournament > sport > global, first
// non-NULL wins. Without any row the bettor sees the standard
// published_odds. See migration 0068_bettor_odds_adjustment.sql for the
// math and bp-range rationale.

import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  bigserial,
  bigint,
  integer,
  uuid,
  timestamp,
  check,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { matches, sports, tournaments } from "./catalog.js";

export const bettorOddsAdjustmentScopeEnum = pgEnum(
  "bettor_odds_adjustment_scope",
  ["global", "sport", "tournament", "match"],
);

export const bettorOddsAdjustmentConfig = pgTable(
  "bettor_odds_adjustment_config",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: bettorOddsAdjustmentScopeEnum().notNull(),
    sportId: integer("sport_id").references(() => sports.id, { onDelete: "cascade" }),
    tournamentId: integer("tournament_id").references(() => tournaments.id, {
      onDelete: "cascade",
    }),
    matchId: bigint("match_id", { mode: "bigint" }).references(() => matches.id, {
      onDelete: "cascade",
    }),
    adjustmentBp: integer("adjustment_bp").notNull(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "bettor_odds_adjustment_bp_range",
      sql`${t.adjustmentBp} >= -9000 AND ${t.adjustmentBp} <= 9000`,
    ),
    check(
      "bettor_odds_adjustment_scope_consistency",
      sql`(${t.scope} = 'global'
            AND ${t.sportId} IS NULL AND ${t.tournamentId} IS NULL AND ${t.matchId} IS NULL)
        OR (${t.scope} = 'sport'
            AND ${t.sportId} IS NOT NULL AND ${t.tournamentId} IS NULL AND ${t.matchId} IS NULL)
        OR (${t.scope} = 'tournament'
            AND ${t.sportId} IS NULL AND ${t.tournamentId} IS NOT NULL AND ${t.matchId} IS NULL)
        OR (${t.scope} = 'match'
            AND ${t.sportId} IS NULL AND ${t.tournamentId} IS NULL AND ${t.matchId} IS NOT NULL)`,
    ),
    uniqueIndex("bettor_odds_adjustment_user_global_uniq")
      .on(t.userId)
      .where(sql`${t.scope} = 'global'`),
    uniqueIndex("bettor_odds_adjustment_user_sport_uniq")
      .on(t.userId, t.sportId)
      .where(sql`${t.scope} = 'sport'`),
    uniqueIndex("bettor_odds_adjustment_user_tournament_uniq")
      .on(t.userId, t.tournamentId)
      .where(sql`${t.scope} = 'tournament'`),
    uniqueIndex("bettor_odds_adjustment_user_match_uniq")
      .on(t.userId, t.matchId)
      .where(sql`${t.scope} = 'match'`),
    index("bettor_odds_adjustment_user_idx").on(t.userId),
  ],
);

export type BettorOddsAdjustmentConfig =
  typeof bettorOddsAdjustmentConfig.$inferSelect;
