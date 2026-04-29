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

// Per-product knobs for the probability-driven products. Effective margin
// at pricing time compounds the per-leg term multiplicatively:
//
//   1 + effective = (1 + margin_bp/10000) × (1 + margin_bp_per_leg/10000)^N
//
// where N is the leg count on the slip. The two-component shape exists so
// Tippot can compound margin per leg the way a combo's odds-product does
// for free, without forcing the same cadence onto Tiple. Both knobs are
// admin-tunable from /admin/bet-products. Defaults seeded by migrations
// 0017 + 0018:
//   tiple : margin_bp=1500, margin_bp_per_leg=0   (flat 15%)
//   tippot: margin_bp=0,    margin_bp_per_leg=500 (compounds — 5% per leg,
//           e.g. N=5 → 1.05^5−1 ≈ 27.6%)
export const betProductConfig = pgTable(
  "bet_product_config",
  {
    productName: text().primaryKey(),
    marginBp: integer().notNull(),
    marginBpPerLeg: integer().notNull().default(0),
    minLegs: smallint().notNull(),
    maxLegs: smallint().notNull(),
    enabled: boolean().notNull().default(true),
    updatedBy: uuid().references(() => users.id),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("bet_product_config_margin_range", sql`${t.marginBp} BETWEEN 0 AND 5000`),
    check(
      "bet_product_config_margin_per_leg_range",
      sql`${t.marginBpPerLeg} BETWEEN 0 AND 5000`,
    ),
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
