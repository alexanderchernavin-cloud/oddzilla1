// ZillaFlash rotation config. Singleton — see migration 0055. The
// engine in services/api hot-loads this row to size offer TTLs
// without an api restart, so admin tweaks via PUT /admin/zillaflash-config
// take effect on the next rotation tick.

import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const zillaflashConfig = pgTable("zillaflash_config", {
  id: text().primaryKey().default("default"),
  enabled: boolean().notNull().default(true),
  prematchTtlSeconds: integer().notNull().default(30),
  liveTtlSeconds: integer().notNull().default(15),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid().references(() => users.id),
});

export type ZillaflashConfig = typeof zillaflashConfig.$inferSelect;
