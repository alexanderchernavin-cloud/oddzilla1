import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  check,
  unique,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

// Push-notification device registry. Migration 0045 created the
// underlying table; this Drizzle schema lets the API service write
// type-safely against it without raw SQL.

export const userDevices = pgTable(
  "user_devices",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text().notNull(),
    platform: text().notNull(),
    appVersion: text(),
    deviceLabel: text(),
    registeredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    // Match migration 0045: `CONSTRAINT user_devices_user_token_unique
    // UNIQUE (user_id, token)`. drizzle-kit emits this as `unique()`
    // — using `uniqueIndex()` here would prompt a spurious ALTER on
    // the next codegen pass (Postgres treats them as equivalent, but
    // the schema introspection shape differs).
    unique("user_devices_user_token_unique").on(t.userId, t.token),
    index("user_devices_user_active_idx").on(t.userId).where(sql`${t.revokedAt} IS NULL`),
    index("user_devices_token_idx").on(t.token),
    check("user_devices_platform_allowlist", sql`${t.platform} IN ('android', 'ios', 'web')`),
  ],
);

export type UserDevice = typeof userDevices.$inferSelect;
export type NewUserDevice = typeof userDevices.$inferInsert;
