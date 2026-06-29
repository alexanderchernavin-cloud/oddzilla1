// ZillaBuild — admin-curated pre-built BetBuilder (OBB) combos. Two
// tables (see migration 0082):
//
//   zillabuild_config  — singleton feature config (master on/off, the
//     allowlist of Oddin provider_market_id values to consider, card
//     shape, min combined-odds floor, response cache TTL). Admins update
//     via PUT /admin/zillabuild-config; the row is never INSERTed at
//     runtime (the CHECK enforces the singleton).
//
//   zillabuild_cards   — persisted card compositions keyed by
//     (match_id, map_number, slot). Selections are chosen once and kept
//     while their legs stay valid; odds are re-quoted from OBB on every
//     read and never stored here.
//
// Column names rely on the global `casing: "snake_case"` setting in
// packages/db/src/index.ts (same as zillaflash.ts).

import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  boolean,
  integer,
  smallint,
  numeric,
  timestamp,
  uuid,
  bigserial,
  bigint,
  jsonb,
  check,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { matches } from "./catalog.js";

export const zillabuildConfig = pgTable(
  "zillabuild_config",
  {
    id: text().primaryKey().default("default"),
    enabled: boolean().notNull().default(true),
    // Empty = consider every OBB-eligible per-map market.
    eligibleProviderMarketIds: integer()
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    cardsPerMap: smallint().notNull().default(2),
    mapCount: smallint().notNull().default(2),
    minLegs: smallint().notNull().default(2),
    maxLegs: smallint().notNull().default(4),
    minCombinedOdds: numeric({ precision: 6, scale: 3 }).notNull().default("2.000"),
    cacheTtlSeconds: integer().notNull().default(20),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid().references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    check("zillabuild_config_singleton", sql`${t.id} = 'default'`),
    check(
      "zillabuild_config_cards_per_map_range",
      sql`${t.cardsPerMap} BETWEEN 1 AND 4`,
    ),
    check(
      "zillabuild_config_map_count_range",
      sql`${t.mapCount} BETWEEN 1 AND 5`,
    ),
    check(
      "zillabuild_config_legs_range",
      sql`${t.minLegs} >= 2 AND ${t.maxLegs} >= ${t.minLegs} AND ${t.maxLegs} <= 8`,
    ),
    check(
      "zillabuild_config_min_combined_odds_range",
      sql`${t.minCombinedOdds} >= 1.01 AND ${t.minCombinedOdds} <= 1000`,
    ),
    check(
      "zillabuild_config_cache_ttl_range",
      sql`${t.cacheTtlSeconds} BETWEEN 5 AND 600`,
    ),
  ],
);

export type ZillabuildConfig = typeof zillabuildConfig.$inferSelect;

export const zillabuildCards = pgTable(
  "zillabuild_cards",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    matchId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    mapNumber: smallint().notNull(),
    slot: smallint().notNull(),
    // [{ marketId: string, outcomeId: string }, ...]
    legs: jsonb().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("zillabuild_cards_match_map_slot_uniq").on(
      t.matchId,
      t.mapNumber,
      t.slot,
    ),
    check("zillabuild_cards_map_number_positive", sql`${t.mapNumber} >= 1`),
    check("zillabuild_cards_slot_nonneg", sql`${t.slot} >= 0`),
  ],
);

export type ZillabuildCard = typeof zillabuildCards.$inferSelect;
