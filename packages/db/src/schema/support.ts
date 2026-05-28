import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

// Migration 0075. Live support chat between bettors and the backoffice.
//
// support_threads:
//   One conversation per bettor. Only one row may be 'open' per
//   (user_id) — enforced by the partial unique index. Denormalised
//   unread counters drive the floating widget badge (unread_user) and
//   the admin sidebar badge (unread_admin) without an extra aggregate
//   query per render.
//
// support_messages:
//   Append-only message log. sender_kind discriminates bettor / admin
//   / system rows; sender_user_id points at whichever user posted
//   (NULL for system).

export const supportMessageSenderEnum = pgEnum("support_message_sender", [
  "user",
  "admin",
  "system",
]);

export const supportThreads = pgTable(
  "support_threads",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text().notNull().default("open"),
    subject: text(),
    unreadUser: integer("unread_user").notNull().default(0),
    unreadAdmin: integer("unread_admin").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    assignedAdminId: uuid("assigned_admin_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByUserId: uuid("closed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    uniqueIndex("support_threads_one_open_per_user")
      .on(t.userId)
      .where(sql`${t.status} = 'open'`),
    index("support_threads_open_recent_idx")
      .on(sql`${t.lastMessageAt} DESC`, sql`${t.id} DESC`)
      .where(sql`${t.status} = 'open'`),
    index("support_threads_user_recent_idx").on(
      t.userId,
      sql`${t.lastMessageAt} DESC`,
    ),
    index("support_threads_unread_admin_idx")
      .on(sql`${t.lastMessageAt} DESC`)
      .where(sql`${t.status} = 'open' AND ${t.unreadAdmin} > 0`),
    check("support_threads_status_chk", sql`${t.status} IN ('open', 'closed')`),
    check("support_threads_unread_user_nonneg", sql`${t.unreadUser} >= 0`),
    check("support_threads_unread_admin_nonneg", sql`${t.unreadAdmin} >= 0`),
    check(
      "support_threads_subject_length",
      sql`${t.subject} IS NULL OR char_length(${t.subject}) BETWEEN 1 AND 200`,
    ),
    check(
      "support_threads_closed_consistency",
      sql`(${t.status} = 'closed') = (${t.closedAt} IS NOT NULL)`,
    ),
  ],
);

export type SupportThreadRow = typeof supportThreads.$inferSelect;
export type NewSupportThreadRow = typeof supportThreads.$inferInsert;

export const supportMessages = pgTable(
  "support_messages",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => supportThreads.id, { onDelete: "cascade" }),
    senderKind: supportMessageSenderEnum("sender_kind").notNull(),
    senderUserId: uuid("sender_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    body: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("support_messages_thread_id_idx").on(t.threadId, sql`${t.id} DESC`),
    index("support_messages_sender_idx")
      .on(t.senderUserId, sql`${t.createdAt} DESC`)
      .where(sql`${t.senderUserId} IS NOT NULL`),
    check(
      "support_messages_body_length",
      sql`char_length(${t.body}) BETWEEN 1 AND 4000`,
    ),
    check(
      "support_messages_user_required",
      sql`${t.senderKind} = 'system' OR ${t.senderUserId} IS NOT NULL`,
    ),
  ],
);

export type SupportMessageRow = typeof supportMessages.$inferSelect;
export type NewSupportMessageRow = typeof supportMessages.$inferInsert;
