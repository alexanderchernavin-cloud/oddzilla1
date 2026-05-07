import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  smallint,
  boolean,
  timestamp,
  uuid,
  numeric,
  check,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

// Single-row config (id = "default"). The CHECK on id enforces the
// singleton; admins update via PUT and never INSERT. See migration
// 0032 for the constraint definitions and rationale.
export const combiBoostConfig = pgTable(
  "combi_boost_config",
  {
    id: text().primaryKey().default("default"),
    enabled: boolean().notNull().default(true),
    minOdds: numeric("min_odds", { precision: 5, scale: 4 }).notNull().default("1.5000"),
    tier1MinLegs: smallint("tier1_min_legs").notNull().default(2),
    tier1Multiplier: numeric("tier1_multiplier", { precision: 5, scale: 4 })
      .notNull()
      .default("1.0300"),
    tier2MinLegs: smallint("tier2_min_legs").notNull().default(4),
    tier2Multiplier: numeric("tier2_multiplier", { precision: 5, scale: 4 })
      .notNull()
      .default("1.0500"),
    tier3MinLegs: smallint("tier3_min_legs").notNull().default(6),
    tier3Multiplier: numeric("tier3_multiplier", { precision: 5, scale: 4 })
      .notNull()
      .default("1.0800"),
    tier4MinLegs: smallint("tier4_min_legs").notNull().default(8),
    tier4Multiplier: numeric("tier4_multiplier", { precision: 5, scale: 4 })
      .notNull()
      .default("1.1200"),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("combi_boost_config_singleton", sql`${t.id} = 'default'`),
    check(
      "combi_boost_config_min_odds_range",
      sql`${t.minOdds} >= 1.0001 AND ${t.minOdds} <= 10`,
    ),
    check(
      "combi_boost_config_tier_legs_order",
      sql`${t.tier1MinLegs} >= 2
        AND ${t.tier2MinLegs} > ${t.tier1MinLegs}
        AND ${t.tier3MinLegs} > ${t.tier2MinLegs}
        AND ${t.tier4MinLegs} > ${t.tier3MinLegs}
        AND ${t.tier4MinLegs} <= 30`,
    ),
    check(
      "combi_boost_config_multiplier_order",
      sql`${t.tier1Multiplier} > 1.0
        AND ${t.tier2Multiplier} > ${t.tier1Multiplier}
        AND ${t.tier3Multiplier} > ${t.tier2Multiplier}
        AND ${t.tier4Multiplier} > ${t.tier3Multiplier}
        AND ${t.tier4Multiplier} <= 5.0`,
    ),
  ],
);

export type CombiBoostConfig = typeof combiBoostConfig.$inferSelect;
