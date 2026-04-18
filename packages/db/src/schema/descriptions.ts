// Market + outcome description templates fetched from Oddin's
// /v1/descriptions/{lang}/markets endpoint. See migration 0006.
//
// Name templates contain {specifier} placeholders that the API
// substitutes at render time. E.g. template "Match handicap {handicap}"
// with specifiers {handicap: "-1.5"} renders as "Match handicap -1.5".
//
// Keyed by (provider_market_id, variant). Variant may be empty string
// when the market has no variant. Outcomes additionally key on
// outcome_id (which is itself a string in Oddin's wire format).

import { sql } from "drizzle-orm";
import {
  pgTable,
  integer,
  text,
  jsonb,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";

export const marketDescriptions = pgTable(
  "market_descriptions",
  {
    providerMarketId: integer().notNull(),
    variant: text().notNull().default(""),
    nameTemplate: text().notNull(),
    specifiersJson: jsonb().notNull().default(sql`'[]'::jsonb`),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.providerMarketId, t.variant] })],
);

export const outcomeDescriptions = pgTable(
  "outcome_descriptions",
  {
    providerMarketId: integer().notNull(),
    variant: text().notNull().default(""),
    outcomeId: text().notNull(),
    nameTemplate: text().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.providerMarketId, t.variant, t.outcomeId] })],
);

export type MarketDescription = typeof marketDescriptions.$inferSelect;
export type OutcomeDescription = typeof outcomeDescriptions.$inferSelect;
