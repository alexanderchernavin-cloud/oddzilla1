import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  customType,
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

// Postgres BYTEA. Drizzle's stock helpers don't ship a bytea wrapper,
// so we declare a thin customType returning Buffer at the row level —
// same pattern as the email token-hash columns.
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

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
    // Lower bound relaxed by migration 0076 — attachment-only messages
    // are valid; the API still rejects "no body AND no attachments".
    check(
      "support_messages_body_length",
      sql`char_length(${t.body}) <= 4000`,
    ),
    check(
      "support_messages_user_required",
      sql`${t.senderKind} = 'system' OR ${t.senderUserId} IS NOT NULL`,
    ),
  ],
);

export type SupportMessageRow = typeof supportMessages.$inferSelect;
export type NewSupportMessageRow = typeof supportMessages.$inferInsert;

// Migration 0076. Up to N attachments per message — each holds the raw
// bytes inline (BYTEA) so a single backup snapshot is enough to restore
// the entire chat history. Per-file cap is 10 MiB, enforced by the
// CHECK below as belt + braces against any future code path that
// forgets the route-level limit.
export const supportAttachments = pgTable(
  "support_attachments",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    messageId: bigint("message_id", { mode: "bigint" })
      .notNull()
      .references(() => supportMessages.id, { onDelete: "cascade" }),
    filename: text().notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    data: bytea().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("support_attachments_message_idx").on(t.messageId),
    check(
      "support_attachments_filename_length",
      sql`char_length(${t.filename}) BETWEEN 1 AND 255`,
    ),
    check(
      "support_attachments_size_range",
      sql`${t.sizeBytes} > 0 AND ${t.sizeBytes} <= 10485760`,
    ),
    // The MIME allowlist that lived here originally was dropped in
    // migration 0077 — `Content-Disposition: attachment` + nosniff on
    // the byte-serve route forces every download to save-to-disk, so
    // any format is safe to store. Capped only by size + per-message
    // count (5).
  ],
);

export type SupportAttachmentRow = typeof supportAttachments.$inferSelect;
export type NewSupportAttachmentRow = typeof supportAttachments.$inferInsert;
