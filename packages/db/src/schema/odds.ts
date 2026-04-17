import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  bigserial,
  bigint,
  integer,
  text,
  numeric,
  timestamp,
  unique,
  uuid,
  check,
  index,
} from "drizzle-orm/pg-core";
import { oddsScopeEnum } from "../enums.js";
import { users } from "./users.js";

// Drizzle does not have first-class partitioned-table support, so we declare
// odds_history as a regular table here; the actual PARTITION BY clause lives
// in the hand-written SQL migration 0000_init.sql. Drizzle only uses this for
// type generation, not migration emission (the TS schema for this table is
// excluded from drizzle-kit's generate output by prefixing `_` in the export).
export const oddsHistory = pgTable(
  "odds_history",
  {
    id: bigserial({ mode: "bigint" }).notNull(),
    marketId: bigint({ mode: "bigint" }).notNull(),
    outcomeId: text().notNull(),
    rawOdds: numeric({ precision: 10, scale: 4 }),
    publishedOdds: numeric({ precision: 10, scale: 4 }),
    ts: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index("odds_history_market_ts_idx").on(t.marketId, sql`${t.ts} DESC`)],
);

export const oddsConfig = pgTable(
  "odds_config",
  {
    id: serial().primaryKey(),
    scope: oddsScopeEnum().notNull(),
    scopeRefId: text(),
    paybackMarginBp: integer().notNull(),
    updatedBy: uuid().references(() => users.id),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("odds_config_scope").on(t.scope, t.scopeRefId),
    check(
      "odds_config_margin_range",
      sql`${t.paybackMarginBp} BETWEEN 0 AND 5000`,
    ),
  ],
);

export type OddsHistoryRow = typeof oddsHistory.$inferSelect;
export type OddsConfig = typeof oddsConfig.$inferSelect;
