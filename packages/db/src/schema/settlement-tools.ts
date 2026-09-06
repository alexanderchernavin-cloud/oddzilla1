// Settlement operator tools
// (migration 20260906T103343_settlement_operator_tools).
//
// fonbet_market_denylist: catalogue tables and sub-event label prefixes the
// Fonbet ingester must not turn into markets, because no grader can settle
// them from the data we have. fonbet_settlement_misses: pending matches the
// results grader could not find in Fonbet's results feed, with what the
// document did list for the same competition. Both exist so the operator
// can see, and act on, what would otherwise be an anonymous counter.

import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { matches } from "./catalog.js";
import { users } from "./users.js";

export const fonbetMarketDenylist = pgTable(
  "fonbet_market_denylist",
  {
    id: serial().primaryKey(),
    // 'table' | 'label_prefix' — CHECK-constrained in SQL.
    kind: text().notNull(),
    providerMarketId: integer("provider_market_id"),
    labelPrefix: text("label_prefix"),
    reason: text().notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    uniqueIndex("fonbet_market_denylist_table_uniq")
      .on(t.providerMarketId)
      .where(sql`${t.kind} = 'table'`),
    uniqueIndex("fonbet_market_denylist_label_uniq")
      .on(sql`lower(${t.labelPrefix})`)
      .where(sql`${t.kind} = 'label_prefix'`),
  ],
);

export type FonbetMarketDenylistRow = typeof fonbetMarketDenylist.$inferSelect;

export const fonbetSettlementMisses = pgTable(
  "fonbet_settlement_misses",
  {
    matchId: bigint("match_id", { mode: "bigint" })
      .primaryKey()
      .references(() => matches.id, { onDelete: "cascade" }),
    providerUrn: text("provider_urn").notNull(),
    homeTeam: text("home_team").notNull(),
    awayTeam: text("away_team").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    segmentId: integer("segment_id").notNull(),
    candidates: jsonb().notNull().default(sql`'[]'::jsonb`),
    openMarkets: integer("open_markets").notNull().default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer().notNull().default(1),
  },
  (t) => [index("fonbet_settlement_misses_last_seen_idx").on(sql`${t.lastSeenAt} DESC`)],
);

export type FonbetSettlementMiss = typeof fonbetSettlementMisses.$inferSelect;
