// Per-sport per-scope storefront ordering for market types. See
// migrations 0019, 0020, and 0057.
//
// Scopes (after migration 0057):
//   match    — markets without a `map` specifier (Match tab + match cards).
//   top      — curated highlights, empty by default. Rendered as the "Top"
//              tab on the match-detail page AND inline on match list cards.
//   map_<N>  — markets carrying `map=<N>`; one independently configurable
//              list per map tab (Map 1 / Map 2 / Map 3 / …).
//
// The pre-0057 single `map` scope is gone — its rows were fanned out to
// map_1..map_5 by the migration so existing operator configuration carried
// over without manual re-entry.
//
// Markets with no row fall back to provider_market_id ascending — the
// legacy default — for `match` and `map_<N>`. The `top` scope is opt-in:
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

export const FE_BASE_SCOPES = ["match", "top"] as const;
export type FeBaseScope = (typeof FE_BASE_SCOPES)[number];
export type FeMapScope = `map_${number}`;
export type FeMarketScope = FeBaseScope | FeMapScope;

export const FE_MARKET_SCOPES: readonly FeBaseScope[] = FE_BASE_SCOPES;

const MAP_SCOPE_RE = /^map_([1-9][0-9]*)$/;

export function isMapScope(s: string): s is FeMapScope {
  return MAP_SCOPE_RE.test(s);
}

export function mapScopeNumber(s: string): number | null {
  const m = MAP_SCOPE_RE.exec(s);
  return m ? Number(m[1]) : null;
}

export function mapScope(n: number): FeMapScope {
  return `map_${n}`;
}

export function isMarketScope(s: string): s is FeMarketScope {
  return s === "match" || s === "top" || isMapScope(s);
}

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
