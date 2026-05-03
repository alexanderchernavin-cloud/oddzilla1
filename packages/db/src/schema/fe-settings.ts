// Per-sport storefront ordering for market types. See migration 0019.
//
// Rows here override the default `provider_market_id ASC` sort on the
// match page (and anywhere else market lists need a stable order).
// Markets with no row fall back to provider_market_id ascending.

import {
  pgTable,
  serial,
  integer,
  uuid,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { sports } from "./catalog.js";
import { users } from "./users.js";

export const feMarketDisplayOrder = pgTable(
  "fe_market_display_order",
  {
    id: serial().primaryKey(),
    sportId: integer()
      .notNull()
      .references(() => sports.id, { onDelete: "cascade" }),
    providerMarketId: integer().notNull(),
    displayOrder: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid().references(() => users.id),
  },
  (t) => [
    unique("fe_market_display_order_sport_market").on(t.sportId, t.providerMarketId),
    index("fe_market_display_order_sport_idx").on(t.sportId, t.displayOrder),
  ],
);

export type FeMarketDisplayOrder = typeof feMarketDisplayOrder.$inferSelect;
