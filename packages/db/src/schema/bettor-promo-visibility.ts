// Per-bettor cascade visibility for promotional features (migration 0071).
//
// One row per (user, promo_kind, scope, ref). The cascade at catalog
// read / bet placement resolves match > tournament > sport > global,
// first explicit row wins. Without any row the bettor sees the
// standard visible=true behaviour. See migration 0071_bettor_promo_visibility.sql
// for design notes.

import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  bigserial,
  bigint,
  integer,
  uuid,
  boolean,
  timestamp,
  check,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { matches, sports, tournaments } from "./catalog.js";

export const bettorPromoKindEnum = pgEnum("bettor_promo_kind", [
  "zillaflash",
  "combi_boost",
]);

export const bettorPromoScopeEnum = pgEnum("bettor_promo_scope", [
  "global",
  "sport",
  "tournament",
  "match",
]);

export const bettorPromoVisibilityConfig = pgTable(
  "bettor_promo_visibility_config",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    promoKind: bettorPromoKindEnum("promo_kind").notNull(),
    scope: bettorPromoScopeEnum().notNull(),
    sportId: integer("sport_id").references(() => sports.id, { onDelete: "cascade" }),
    tournamentId: integer("tournament_id").references(() => tournaments.id, {
      onDelete: "cascade",
    }),
    matchId: bigint("match_id", { mode: "bigint" }).references(() => matches.id, {
      onDelete: "cascade",
    }),
    visible: boolean().notNull(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "bettor_promo_visibility_scope_consistency",
      sql`(${t.scope} = 'global'
            AND ${t.sportId} IS NULL AND ${t.tournamentId} IS NULL AND ${t.matchId} IS NULL)
        OR (${t.scope} = 'sport'
            AND ${t.sportId} IS NOT NULL AND ${t.tournamentId} IS NULL AND ${t.matchId} IS NULL)
        OR (${t.scope} = 'tournament'
            AND ${t.sportId} IS NULL AND ${t.tournamentId} IS NOT NULL AND ${t.matchId} IS NULL)
        OR (${t.scope} = 'match'
            AND ${t.sportId} IS NULL AND ${t.tournamentId} IS NULL AND ${t.matchId} IS NOT NULL)`,
    ),
    uniqueIndex("bettor_promo_visibility_user_global_uniq")
      .on(t.userId, t.promoKind)
      .where(sql`${t.scope} = 'global'`),
    uniqueIndex("bettor_promo_visibility_user_sport_uniq")
      .on(t.userId, t.promoKind, t.sportId)
      .where(sql`${t.scope} = 'sport'`),
    uniqueIndex("bettor_promo_visibility_user_tournament_uniq")
      .on(t.userId, t.promoKind, t.tournamentId)
      .where(sql`${t.scope} = 'tournament'`),
    uniqueIndex("bettor_promo_visibility_user_match_uniq")
      .on(t.userId, t.promoKind, t.matchId)
      .where(sql`${t.scope} = 'match'`),
    index("bettor_promo_visibility_user_idx").on(t.userId),
  ],
);

export type BettorPromoVisibilityConfig =
  typeof bettorPromoVisibilityConfig.$inferSelect;
export type BettorPromoKind = (typeof bettorPromoKindEnum.enumValues)[number];
