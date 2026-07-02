// Per-sport per-scope storefront ordering for market types. See
// migrations 0019, 0020, 0057, and 0084.
//
// Scopes (after migration 0084):
//   match        — markets without a `map` specifier (Match tab + match cards).
//   top          — curated highlights, empty by default. Rendered as the "Top"
//                  tab on the match-detail page AND inline on match list cards.
//   map_<N>      — markets carrying `map=<N>`; one independently configurable
//                  list per map tab (Map 1 / Map 2 / Map 3 / …).
//   custom_<key> — admin-created curated tab (fe_market_groups row carries
//                  the label + tab position). Content semantics are identical
//                  to `top`: opt-in list of provider_market_ids, one
//                  representative market rendered per id. The key is a
//                  random [a-z0-9]{12} suffix generated at group creation —
//                  stable across label renames.
//
// The pre-0057 single `map` scope is gone — its rows were fanned out to
// map_1..map_5 by the migration so existing operator configuration carried
// over without manual re-entry.
//
// Markets with no row fall back to provider_market_id ascending — the
// legacy default — for `match` and `map_<N>`. The `top` and `custom_<key>`
// scopes are opt-in: no rows = no tab content.

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
export type FeCustomScope = `custom_${string}`;
export type FeMarketScope = FeBaseScope | FeMapScope | FeCustomScope;

export const FE_MARKET_SCOPES: readonly FeBaseScope[] = FE_BASE_SCOPES;

const MAP_SCOPE_RE = /^map_([1-9][0-9]*)$/;
// Mirrors the DB CHECK on fe_market_groups.scope / fe_market_display_order
// .scope (migration 0084). Keys are API-generated random hex, but the CHECK
// (and this regex) accept any [a-z0-9]{4,32} suffix for forward flexibility.
const CUSTOM_SCOPE_RE = /^custom_([a-z0-9]{4,32})$/;

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

export function isCustomScope(s: string): s is FeCustomScope {
  return CUSTOM_SCOPE_RE.test(s);
}

// Curated scopes have no implicit market pool — content is exactly the
// admin-ordered list, and the storefront renders one representative
// market per provider_market_id.
export function isCuratedScope(s: string): boolean {
  return s === "top" || isCustomScope(s);
}

export function isMarketScope(s: string): s is FeMarketScope {
  return s === "match" || s === "top" || isMapScope(s) || isCustomScope(s);
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

// Tab (group) configuration for the match-detail page (migration 0084).
// A row exists only for tabs the admin has touched:
//   custom groups — scope 'custom_<key>', label NOT NULL (the tab title).
//   built-in anchors — scope 'match' | 'top' | 'map_<N>', label NULL;
//     the row only carries display_order after a tab reorder.
// Tabs WITH a row sort by display_order and render before tabs without
// one (which keep the default order: top, match, map_1..N).
export const feMarketGroups = pgTable(
  "fe_market_groups",
  {
    id: serial().primaryKey(),
    sportId: integer()
      .notNull()
      .references(() => sports.id, { onDelete: "cascade" }),
    scope: text().notNull().$type<FeMarketScope>(),
    label: text(),
    displayOrder: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid().references(() => users.id),
  },
  (t) => [
    unique("fe_market_groups_sport_scope").on(t.sportId, t.scope),
    index("fe_market_groups_sport_order_idx").on(t.sportId, t.displayOrder),
  ],
);

export type FeMarketGroup = typeof feMarketGroups.$inferSelect;
