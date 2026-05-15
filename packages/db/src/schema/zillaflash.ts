// ZillaFlash rotation config. Singleton — see migrations 0055 + 0056.
// The engine in services/api hot-loads this row (CONFIG_CACHE_MS) so
// admin tweaks via PUT /admin/zillaflash-config take effect on the
// next rotation tick without an api restart.
//
// 0056 split the original single `key_delta_pct` constant into
// separate prematch + live values and added a tournament risk-tier
// window per kind, so operators can run a tighter discount on live
// markets (where odds move fast) and a fatter prematch sweetener,
// or pull live boosts from a different tier band than prematch.

import {
  pgTable,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const zillaflashConfig = pgTable("zillaflash_config", {
  id: text().primaryKey().default("default"),
  enabled: boolean().notNull().default(true),
  prematchTtlSeconds: integer().notNull().default(30),
  liveTtlSeconds: integer().notNull().default(15),
  // Per-kind Netwinstable key delta (percentage points to shave off
  // the published-book key). 0 disables the boost effectively; the
  // current product baseline is 3.00 pp on both kinds.
  prematchKeyDeltaPct: numeric({ precision: 4, scale: 2 })
    .notNull()
    .default("3.00"),
  liveKeyDeltaPct: numeric({ precision: 4, scale: 2 })
    .notNull()
    .default("3.00"),
  // Per-kind tournament risk-tier window (inclusive). Defaults
  // mirror the pre-0056 hardcoded range (1..3 = flagship only).
  prematchMinTier: integer().notNull().default(1),
  prematchMaxTier: integer().notNull().default(3),
  liveMinTier: integer().notNull().default(1),
  liveMaxTier: integer().notNull().default(3),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid().references(() => users.id),
});

export type ZillaflashConfig = typeof zillaflashConfig.$inferSelect;
