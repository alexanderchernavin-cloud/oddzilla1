import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  customType,
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
