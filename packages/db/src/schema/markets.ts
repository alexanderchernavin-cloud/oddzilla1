import { sql } from "drizzle-orm";
import {
  pgTable,
  bigserial,
  bigint,
  integer,
  smallint,
  text,
  boolean,
  timestamp,
  jsonb,
  numeric,
  primaryKey,
  unique,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { outcomeResultEnum } from "../enums.js";
import { matches } from "./catalog.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const markets = pgTable(
  "markets",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    matchId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    providerMarketId: integer().notNull(),
    specifiersJson: jsonb().notNull().default(sql`'{}'::jsonb`),
    specifiersHash: bytea().notNull(),
    status: smallint().notNull().default(0),
    lastOddinTs: bigint({ mode: "bigint" }).notNull().default(0n),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("markets_match_mkt_spec").on(t.matchId, t.providerMarketId, t.specifiersHash),
    index("markets_match_status_idx").on(t.matchId, t.status),
  ],
);

export const marketOutcomes = pgTable(
  "market_outcomes",
  {
    marketId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => markets.id, { onDelete: "cascade" }),
    outcomeId: text().notNull(),
    name: text().notNull(),
    rawOdds: numeric({ precision: 10, scale: 4 }),
    publishedOdds: numeric({ precision: 10, scale: 4 }),
    probability: numeric({ precision: 8, scale: 7 }),
    active: boolean().notNull().default(true),
    result: outcomeResultEnum(),
    voidFactor: numeric({ precision: 4, scale: 3 }),
    lastOddinTs: bigint({ mode: "bigint" }).notNull().default(0n),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.marketId, t.outcomeId] })],
);

export type Market = typeof markets.$inferSelect;
export type MarketOutcome = typeof marketOutcomes.$inferSelect;
