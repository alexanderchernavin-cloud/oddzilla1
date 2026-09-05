// Per-sport per-scope storefront ordering for market types. See
// migrations 0019, 0020, 0057, 0084, and 0106.
//
// A "scope" is one tab on the match-detail page. The grammar and the
// per-market derivation live in `@oddzilla/types/market-scope` — the api
// and the web admin read the same module, and the DB CHECK constraints
// mirror its regexes. Re-exported here so schema consumers keep importing
// the predicates from `@oddzilla/db` as they always have.
//
//   match        — the base event: no `map`, no Fonbet sub-event.
//   top          — curated highlights, empty by default. Rendered as the "Top"
//                  tab on the match-detail page AND inline on match list cards.
//   map_<N>      — markets carrying `map=<N>`; one independently configurable
//                  list per map tab (Map 1 / Map 2 / Map 3 / …).
//   fb_<kinds>   — a Fonbet sub-event (migration 0106): halves, periods,
//                  corners, cards, and their nestings. The tab id comes from
//                  the `variant` specifier (`fb:400100/10100201` →
//                  `fb_400100_10100201`); the tab LABEL comes from the market
//                  description's prefix ("1st half corners: Match result").
//                  `fb_players` collects every per-player variant.
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
// legacy default — for `match`, `map_<N>` and `fb_<kinds>`. The `top` and
// `custom_<key>` scopes are opt-in: no rows = no tab content.

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
import {
  FE_BASE_SCOPES,
  type FeBaseScope,
  type FeCustomScope,
  type FeMapScope,
  type FeMarketScope,
  type FeSubEventScope,
  isCuratedScope,
  isCustomScope,
  isMapScope,
  isMarketScope,
  isSubEventScope,
  mapScope,
  mapScopeNumber,
} from "@oddzilla/types/market-scope";
import { sports } from "./catalog.js";
import { users } from "./users.js";

export {
  FE_BASE_SCOPES,
  isCuratedScope,
  isCustomScope,
  isMapScope,
  isMarketScope,
  isSubEventScope,
  mapScope,
  mapScopeNumber,
};
export type {
  FeBaseScope,
  FeCustomScope,
  FeMapScope,
  FeMarketScope,
  FeSubEventScope,
};

export const FE_MARKET_SCOPES: readonly FeBaseScope[] = FE_BASE_SCOPES;

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
//   built-in anchors — scope 'match' | 'top' | 'map_<N>' | 'fb_<kinds>',
//     label NULL; the row only carries display_order after a tab reorder.
// Tabs WITH a row sort by display_order and render before tabs without
// one (which keep the default order: top, match, map_1..N, sub-events).
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
