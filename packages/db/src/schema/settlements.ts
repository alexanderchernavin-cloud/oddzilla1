import { sql } from "drizzle-orm";
import {
  pgTable,
  bigserial,
  bigint,
  text,
  jsonb,
  timestamp,
  unique,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { settlementTypeEnum } from "../enums.js";
import { markets } from "./markets.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const settlements = pgTable(
  "settlements",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    eventUrn: text().notNull(),
    marketId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => markets.id),
    specifiersHash: bytea().notNull(),
    type: settlementTypeEnum().notNull(),
    payloadHash: bytea().notNull(),
    payloadJson: jsonb().notNull(),
    processedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("settlements_unique").on(
      t.eventUrn,
      t.marketId,
      t.specifiersHash,
      t.type,
      t.payloadHash,
    ),
    index("settlements_event_idx").on(t.eventUrn, sql`${t.processedAt} DESC`),
    // Reverse FK probe: "is this market_id referenced by any settlement?"
    // Used by the admin recovery flush (NOT EXISTS subquery) and any
    // future per-market settlement lookup. The unique index above starts
    // with event_urn so it can't satisfy a market_id-alone predicate.
    index("settlements_market_id_idx").on(t.marketId),
  ],
);

export type Settlement = typeof settlements.$inferSelect;
