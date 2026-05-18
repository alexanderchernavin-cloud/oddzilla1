import { sql } from "drizzle-orm";
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { tickets } from "./tickets.js";

// Push-notification outbox. Migration 0057 created the underlying table;
// this Drizzle schema lets the API service write type-safely against it.
//
// Producer: services/settlement (Go) inserts a row inside the same
// transaction that flips a winning ticket to `settled`, then fires
// `pg_notify('push_outbox')` after commit.
//
// Consumer: services/api LISTENs on `push_outbox`, claims pending rows,
// sends the FCM message via Firebase Admin SDK, marks the row as sent.
// A periodic sweep catches anything that slipped past the NOTIFY (api
// restart, transient Firebase error).

export const pushNotificationsOutbox = pgTable(
  "push_notifications_outbox",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    ticketId: uuid().references(() => tickets.id, { onDelete: "cascade" }),
    payload: jsonb().notNull(),
    enqueuedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp({ withTimezone: true }),
    attempts: integer().notNull().default(0),
    lastError: text(),
  },
  (t) => [
    uniqueIndex("push_outbox_kind_ticket_unique")
      .on(t.kind, t.ticketId)
      .where(sql`${t.ticketId} IS NOT NULL`),
    index("push_outbox_pending_idx")
      .on(t.enqueuedAt)
      .where(sql`${t.sentAt} IS NULL`),
  ],
);

export type PushNotificationOutboxRow = typeof pushNotificationsOutbox.$inferSelect;
export type NewPushNotificationOutboxRow = typeof pushNotificationsOutbox.$inferInsert;
