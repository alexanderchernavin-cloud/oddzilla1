import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

// Postgres INET — used for password-reset request audit. We store the
// raw client IP so an operator can confirm reset traffic isn't coming
// from one suspicious peer hammering many emails.
const inet = customType<{ data: string }>({
  dataType() {
    return "inet";
  },
});

// Migration 0073. Three tables for the transactional email pipeline.
//
// email_outbox: durable queue. Mirrors push_notifications_outbox; api
// drains via LISTEN/NOTIFY + 30 s sweep, dispatches through the
// configured provider client.
//
// email_verification_tokens / password_reset_tokens: hash-only token
// storage so a DB exfiltration leaves the raw tokens useless. TTL +
// single-use semantics enforced in the route handlers.

export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    kind: text().notNull(),
    userId: uuid().references(() => users.id, { onDelete: "cascade" }),
    toAddress: text("to_address").notNull(),
    subject: text().notNull(),
    payload: jsonb().notNull(),
    dedupKey: text("dedup_key"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    attempts: integer().notNull().default(0),
    lastError: text("last_error"),
    // Migration 0074 — thread participation + body lifting for the
    // admin_outbound / admin_reply kinds. Existing kinds keep their
    // bodies inside `payload`; the worker's render layer is what
    // decides which fields to consume.
    threadId: uuid("thread_id"),
    providerMessageId: text("provider_message_id"),
    textBody: text("text_body"),
    htmlBody: text("html_body"),
    inReplyTo: text("in_reply_to"),
  },
  (t) => [
    uniqueIndex("email_outbox_kind_dedup_unique")
      .on(t.kind, t.dedupKey)
      .where(sql`${t.dedupKey} IS NOT NULL`),
    index("email_outbox_pending_idx")
      .on(t.enqueuedAt)
      .where(sql`${t.sentAt} IS NULL`),
    index("email_outbox_user_idx")
      .on(t.userId, t.enqueuedAt)
      .where(sql`${t.userId} IS NOT NULL`),
    index("email_outbox_thread_sent_idx")
      .on(t.threadId, t.sentAt)
      .where(sql`${t.threadId} IS NOT NULL`),
    uniqueIndex("email_outbox_provider_message_id_unique")
      .on(t.providerMessageId)
      .where(sql`${t.providerMessageId} IS NOT NULL`),
  ],
);

export type EmailOutboxRow = typeof emailOutbox.$inferSelect;
export type NewEmailOutboxRow = typeof emailOutbox.$inferInsert;

export const emailVerificationTokens = pgTable(
  "email_verification_tokens",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: customType<{ data: Buffer }>({
      dataType() {
        return "bytea";
      },
    })("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("email_verification_tokens_hash_unique").on(t.tokenHash),
    index("email_verification_tokens_expires_idx")
      .on(t.expiresAt)
      .where(sql`${t.usedAt} IS NULL`),
    check(
      "email_verification_tokens_hash_len",
      sql`octet_length(${t.tokenHash}) = 32`,
    ),
  ],
);

export type EmailVerificationTokenRow = typeof emailVerificationTokens.$inferSelect;
export type NewEmailVerificationTokenRow = typeof emailVerificationTokens.$inferInsert;

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: customType<{ data: Buffer }>({
      dataType() {
        return "bytea";
      },
    })("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    requestedIp: inet("requested_ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("password_reset_tokens_hash_unique").on(t.tokenHash),
    index("password_reset_tokens_expires_idx")
      .on(t.expiresAt)
      .where(sql`${t.usedAt} IS NULL`),
    check(
      "password_reset_tokens_hash_len",
      sql`octet_length(${t.tokenHash}) = 32`,
    ),
  ],
);

export type PasswordResetTokenRow = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetTokenRow = typeof passwordResetTokens.$inferInsert;

// Migration 0074 — inbound mail. Threads group inbound + outbound
// messages into conversations; the inbox view lists threads ordered by
// most-recent activity. Outbound messages join via emailOutbox.threadId.

export const emailThreads = pgTable(
  "email_threads",
  {
    id: uuid().primaryKey().defaultRandom(),
    subject: text().notNull(),
    normalisedSubject: text("normalised_subject").notNull(),
    firstFrom: text("first_from"),
    firstTo: text("first_to"),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    inboundCount: integer("inbound_count").notNull().default(0),
    outboundCount: integer("outbound_count").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    assignedUserId: uuid("assigned_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Most-recent-activity ordering, computed in SQL to keep the index
    // useful for the inbox-list query.
    index("email_threads_last_activity_idx").on(
      sql`GREATEST(COALESCE(${t.lastInboundAt}, ${t.createdAt}), COALESCE(${t.lastOutboundAt}, ${t.createdAt})) DESC`,
    ),
    index("email_threads_normalised_subject_idx")
      .on(t.normalisedSubject)
      .where(sql`${t.archivedAt} IS NULL`),
    index("email_threads_archived_at_idx")
      .on(t.archivedAt)
      .where(sql`${t.archivedAt} IS NOT NULL`),
  ],
);

export type EmailThreadRow = typeof emailThreads.$inferSelect;
export type NewEmailThreadRow = typeof emailThreads.$inferInsert;

export const emailInbound = pgTable(
  "email_inbound",
  {
    id: uuid().primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => emailThreads.id, { onDelete: "cascade" }),
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    referencesChain: text("references_chain"),
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),
    toAddress: text("to_address").notNull(),
    subject: text().notNull(),
    textBody: text("text_body"),
    htmlBody: text("html_body"),
    attachmentsMeta: jsonb("attachments_meta").notNull().default(sql`'[]'::jsonb`),
    rawHeaders: jsonb("raw_headers").notNull().default(sql`'{}'::jsonb`),
    spamScore: numeric("spam_score", { precision: 5, scale: 2 }),
    envelopeFrom: text("envelope_from"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
    readByUserId: uuid("read_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    uniqueIndex("email_inbound_message_id_unique")
      .on(t.messageId)
      .where(sql`${t.messageId} IS NOT NULL`),
    index("email_inbound_thread_received_idx").on(t.threadId, t.receivedAt),
    index("email_inbound_unread_idx")
      .on(t.receivedAt)
      .where(sql`${t.readAt} IS NULL`),
  ],
);

export type EmailInboundRow = typeof emailInbound.$inferSelect;
export type NewEmailInboundRow = typeof emailInbound.$inferInsert;
