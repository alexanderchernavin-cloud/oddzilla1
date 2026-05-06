import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  inet,
  uniqueIndex,
  index,
  customType,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    refreshTokenHash: bytea().notNull(),
    deviceId: text(),
    userAgent: text(),
    ipInet: inet(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    // Family bookkeeping for refresh-token replay detection. familyId is
    // shared across every session descending from the same login; on
    // refresh we mint a new session with the same familyId. If a refresh
    // token is presented for an already-revoked session, we revoke every
    // session in the family — the canonical "stolen token detected"
    // response.
    familyId: uuid("family_id").notNull(),
    parentSessionId: uuid("parent_session_id").references(
      (): AnyPgColumn => sessions.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    uniqueIndex("sessions_refresh_idx").on(t.refreshTokenHash),
    index("sessions_user_active_idx").on(t.userId).where(sql`${t.revokedAt} IS NULL`),
    index("sessions_family_idx").on(t.familyId).where(sql`${t.revokedAt} IS NULL`),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
