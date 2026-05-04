// Per-sport per-scope storefront ordering for market types. See
// migrations 0019 + 0020.
//
// Three scopes:
//   match — markets without a `map` specifier (Match tab + match cards)
//   map   — markets with a `map` specifier; one order applies to every
//           map_N tab so Map 1 / Map 2 / Map 3 stay consistent
//   top   — curated highlights, empty by default. Rendered as a "Top" tab
//           on the match-detail page AND inline on match list cards.
//
// Markets with no row fall back to provider_market_id ascending — the
// legacy default — for `match` and `map`. The `top` scope is opt-in:
// no rows = no Top tab content.

import {
  pgTable,
  serial,
  integer,
  text,
  uuid,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { sports } from "./catalog.js";
import { users } from "./users.js";

export type FeMarketScope = "match" | "map" | "top";
export const FE_MARKET_SCOPES: readonly FeMarketScope[] = ["match", "map", "top"] as const;

export const feMarketDisplayOrder = pgTable(
  "fe_market_display_order",
  {
    id: serial().primaryKey(),
    sportId: integer()
      .notNull()
      .references(() => sports.id, { onDelete: "cascade" }),
    scope: text().notNull().default("match").$type<FeMarketScope>(),
    providerMarketId: integer().notNull(),
    displayOrder: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid().references(() => users.id),
  },
  (t) => [
    unique("fe_market_display_order_sport_scope_market").on(
      t.sportId,
      t.scope,
      t.providerMarketId,
    ),
    index("fe_market_display_order_sport_scope_idx").on(
      t.sportId,
      t.scope,
      t.displayOrder,
    ),
  ],
);

export type FeMarketDisplayOrder = typeof feMarketDisplayOrder.$inferSelect;
