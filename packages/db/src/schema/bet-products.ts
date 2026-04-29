import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  smallint,
  boolean,
  timestamp,
  uuid,
  check,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

// Per-product knobs for the new probability-driven products. margin_bp uses
// the same convention as odds_config (offered = fair / (1 + bp/10000)).
// Defaults seeded in 0014_tiple_tippot.sql: tiple 2..20 / 1500 bp,
// tippot 3..12 / 1500 bp.
export const betProductConfig = pgTable(
  "bet_product_config",
  {
    productName: text().primaryKey(),
    marginBp: integer().notNull(),
    minLegs: smallint().notNull(),
    maxLegs: smallint().notNull(),
    enabled: boolean().notNull().default(true),
    updatedBy: uuid().references(() => users.id),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("bet_product_config_margin_range", sql`${t.marginBp} BETWEEN 0 AND 5000`),
    check("bet_product_config_min_legs", sql`${t.minLegs} >= 2`),
    check(
      "bet_product_config_max_legs",
      sql`${t.maxLegs} >= ${t.minLegs} AND ${t.maxLegs} <= 30`,
    ),
    check(
      "bet_product_config_product_name",
      sql`${t.productName} IN ('tiple', 'tippot')`,
    ),
  ],
);

export type BetProductConfig = typeof betProductConfig.$inferSelect;
