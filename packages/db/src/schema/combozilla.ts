// ComboZilla — the lobby's prebuilt 3-fold carousel — operator config.
// Two tables (migration 20260906T015446_combozilla_config):
//
//   combozilla_config       singleton (id = 'default'). Master switch, the
//     risk tiers whose tournaments qualify by default, whether an untiered
//     tournament qualifies, and the sports allowed to hold more than one
//     card at once. Admins update via PUT /admin/combozilla-config; the
//     row is never INSERTed at runtime (the CHECK enforces the singleton).
//
//   combozilla_scope_rules  operator overrides at sport / category /
//     tournament scope, each 'allow' or 'block'. Most specific wins:
//     tournament > category > sport > tier default. 'allow' is
//     unconditional — it puts the scope in regardless of risk tier — and
//     'block' keeps it out regardless. One typed FK per scope tier so ON
//     DELETE CASCADE cleans up when a tournament or category goes away.
//
// Resolution (SQL, one place): services/api/src/lib/combozilla.ts.
//
// Column names rely on the global `casing: "snake_case"` setting in
// packages/db/src/index.ts (same as zillabuild.ts).

import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  boolean,
  integer,
  smallint,
  timestamp,
  uuid,
  bigserial,
  check,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { sports, categories, tournaments } from "./catalog.js";

export const combozillaConfig = pgTable(
  "combozilla_config",
  {
    id: text().primaryKey().default("default"),
    enabled: boolean().notNull().default(true),
    // 1..10, mirroring tournaments.risk_tier. Empty = nothing qualifies by
    // tier alone, so only 'allow' rules feed the carousel.
    eligibleRiskTiers: smallint()
      .array()
      .notNull()
      .default(sql`'{1,2,3}'::smallint[]`),
    allowUntiered: boolean().notNull().default(false),
    // Slugs, like users.hidden_sports — the storefront addresses a sport
    // by slug everywhere.
    multiCardSportSlugs: text()
      .array()
      .notNull()
      .default(sql`'{cs2,dota2,lol}'::text[]`),
    updatedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("combozilla_config_singleton", sql`${t.id} = 'default'`),
    check(
      "combozilla_config_tiers_range",
      sql`${t.eligibleRiskTiers} <@ ARRAY[1,2,3,4,5,6,7,8,9,10]::smallint[]`,
    ),
    check(
      "combozilla_config_multi_card_cap",
      sql`cardinality(${t.multiCardSportSlugs}) <= 100`,
    ),
  ],
);

export type CombozillaConfig = typeof combozillaConfig.$inferSelect;

export const COMBOZILLA_RULE_SCOPES = ["sport", "category", "tournament"] as const;
export type CombozillaRuleScope = (typeof COMBOZILLA_RULE_SCOPES)[number];

export const COMBOZILLA_RULE_MODES = ["allow", "block"] as const;
export type CombozillaRuleMode = (typeof COMBOZILLA_RULE_MODES)[number];

export const combozillaScopeRules = pgTable(
  "combozilla_scope_rules",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    // CHECK'd TEXT rather than an enum, so a fourth scope is one ALTER
    // and not the two-file add-value dance (0087 / 0101 / 0106).
    scope: text().$type<CombozillaRuleScope>().notNull(),
    sportId: integer().references(() => sports.id, { onDelete: "cascade" }),
    categoryId: integer().references(() => categories.id, { onDelete: "cascade" }),
    tournamentId: integer().references(() => tournaments.id, {
      onDelete: "cascade",
    }),
    mode: text().$type<CombozillaRuleMode>().notNull(),
    updatedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "combozilla_scope_rules_scope_check",
      sql`${t.scope} IN ('sport', 'category', 'tournament')`,
    ),
    check("combozilla_scope_rules_mode_check", sql`${t.mode} IN ('allow', 'block')`),
    check(
      "combozilla_scope_rules_scope_consistency",
      sql`(${t.scope} = 'sport'
            AND ${t.sportId} IS NOT NULL AND ${t.categoryId} IS NULL AND ${t.tournamentId} IS NULL)
        OR (${t.scope} = 'category'
            AND ${t.sportId} IS NULL AND ${t.categoryId} IS NOT NULL AND ${t.tournamentId} IS NULL)
        OR (${t.scope} = 'tournament'
            AND ${t.sportId} IS NULL AND ${t.categoryId} IS NULL AND ${t.tournamentId} IS NOT NULL)`,
    ),
    uniqueIndex("combozilla_scope_rules_sport_uniq")
      .on(t.sportId)
      .where(sql`${t.scope} = 'sport'`),
    uniqueIndex("combozilla_scope_rules_category_uniq")
      .on(t.categoryId)
      .where(sql`${t.scope} = 'category'`),
    uniqueIndex("combozilla_scope_rules_tournament_uniq")
      .on(t.tournamentId)
      .where(sql`${t.scope} = 'tournament'`),
  ],
);

export type CombozillaScopeRule = typeof combozillaScopeRules.$inferSelect;
