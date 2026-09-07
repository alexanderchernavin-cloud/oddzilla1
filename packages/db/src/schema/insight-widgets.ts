// ZillaTips / ZillaFacts — operator control for the two match-page
// insight widgets (migration 20260907T093356_insight_widget_rules).
//
// One table for both widgets, keyed by `widget`, the same choice
// bettor_promo_visibility_config makes for its promo kinds: they are the
// same decision about the same catalogue, and a second table would mean a
// second resolver to keep in step.
//
// Resolution is most-specific-wins —
//     market > tournament > category > sport > global
// — with `global` seeded for both widgets, so there is always an answer
// and the fallback is a row an operator can see rather than a constant in
// code. `market` is a market TYPE (provider_market_id), not a market row:
// rows are created and settled per match and would make every rule
// garbage within a day. It sits at the top because the widget renders ON
// a market, so a rule naming that market is the most direct statement
// about what is being drawn — at the cost that such a rule spans every
// sport quoting that id.
//
// Resolution lives in ONE place:
// services/api/src/lib/insight-widgets.ts.
//
// Column names rely on the global `casing: "snake_case"` setting in
// packages/db/src/index.ts.

import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  uuid,
  bigserial,
  check,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";
import { sports, categories, tournaments } from "./catalog.js";

/** The widgets this table governs. */
export const INSIGHT_WIDGETS = ["zillatips", "zillafacts"] as const;
export type InsightWidget = (typeof INSIGHT_WIDGETS)[number];

/** Scope tiers, listed MOST specific first — the resolver walks this order. */
export const INSIGHT_SCOPES = [
  "market",
  "tournament",
  "category",
  "sport",
  "global",
] as const;
export type InsightScope = (typeof INSIGHT_SCOPES)[number];

export const insightWidgetRules = pgTable(
  "insight_widget_rules",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    widget: text().notNull(),
    scope: text().notNull(),
    sportId: integer().references(() => sports.id, { onDelete: "cascade" }),
    categoryId: integer().references(() => categories.id, { onDelete: "cascade" }),
    tournamentId: integer().references(() => tournaments.id, { onDelete: "cascade" }),
    // Market TYPE, not a market row — see the note above.
    providerMarketId: integer(),
    enabled: boolean().notNull(),
    updatedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("insight_widget_rules_widget_check", sql`${t.widget} IN ('zillatips', 'zillafacts')`),
    check(
      "insight_widget_rules_scope_check",
      sql`${t.scope} IN ('global', 'sport', 'category', 'tournament', 'market')`,
    ),
    uniqueIndex("insight_widget_rules_global_uniq")
      .on(t.widget)
      .where(sql`${t.scope} = 'global'`),
    uniqueIndex("insight_widget_rules_sport_uniq")
      .on(t.widget, t.sportId)
      .where(sql`${t.scope} = 'sport'`),
    uniqueIndex("insight_widget_rules_category_uniq")
      .on(t.widget, t.categoryId)
      .where(sql`${t.scope} = 'category'`),
    uniqueIndex("insight_widget_rules_tournament_uniq")
      .on(t.widget, t.tournamentId)
      .where(sql`${t.scope} = 'tournament'`),
    uniqueIndex("insight_widget_rules_market_uniq")
      .on(t.widget, t.providerMarketId)
      .where(sql`${t.scope} = 'market'`),
    index("insight_widget_rules_widget_idx").on(t.widget),
  ],
);

export type InsightWidgetRule = typeof insightWidgetRules.$inferSelect;
