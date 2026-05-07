import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  timestamp,
  unique,
  index,
  check,
} from "drizzle-orm/pg-core";
import {
  chainNetworkEnum,
  depositStatusEnum,
  depositIntentStatusEnum,
  withdrawalStatusEnum,
} from "../enums.js";
import { users } from "./users.js";

// Legacy deposits table — written to by the pre-0032 per-user HD-address
// flow. Migration 0032 stopped writes; rows remain for historical audit.
// New deposits land in `deposit_intents` instead.
export const deposits = pgTable(
  "deposits",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    network: chainNetworkEnum().notNull(),
    txHash: text().notNull(),
    logIndex: integer().notNull().default(0),
    toAddress: text().notNull(),
    amountMicro: bigint({ mode: "bigint" }).notNull(),
    confirmations: integer().notNull().default(0),
    status: depositStatusEnum().notNull().default("seen"),
    blockNumber: bigint({ mode: "bigint" }),
    blockHash: text("block_hash"),
    seenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    creditedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique("deposits_tx_unique").on(t.network, t.txHash, t.logIndex),
    check("deposits_amount_pos", sql`${t.amountMicro} > 0`),
    index("deposits_user_idx").on(t.userId, sql`${t.seenAt} DESC`),
    index("deposits_status_idx").on(t.status).where(sql`${t.status} <> 'credited'`),
  ],
);

// User-submitted tx-hash claims (migration 0032). With a single shared
// receive address, the watcher can't attribute a Transfer to a user
// from on-chain data alone — the user pastes the hash they sent and the
// watcher verifies / credits.
export const depositIntents = pgTable(
  "deposit_intents",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    network: chainNetworkEnum().notNull().default("ERC20"),
    txHash: text("tx_hash").notNull(),
    toAddress: text("to_address"),
    fromAddress: text("from_address"),
    amountMicro: bigint("amount_micro", { mode: "bigint" }),
    blockNumber: bigint("block_number", { mode: "bigint" }),
    blockHash: text("block_hash"),
    logIndex: integer("log_index"),
    confirmations: integer().notNull().default(0),
    status: depositIntentStatusEnum().notNull().default("pending"),
    failureReason: text("failure_reason"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    creditedAt: timestamp("credited_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  },
  (t) => [
    unique("deposit_intents_tx_unique").on(t.network, t.txHash),
    check(
      "deposit_intents_amount_pos",
      sql`${t.amountMicro} IS NULL OR ${t.amountMicro} > 0`,
    ),
    index("deposit_intents_user_idx").on(t.userId, sql`${t.submittedAt} DESC`),
    index("deposit_intents_pending_idx")
      .on(t.status)
      .where(sql`${t.status} IN ('pending', 'confirming')`),
  ],
);

export const withdrawals = pgTable(
  "withdrawals",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    network: chainNetworkEnum().notNull(),
    toAddress: text().notNull(),
    amountMicro: bigint({ mode: "bigint" }).notNull(),
    feeMicro: bigint({ mode: "bigint" }).notNull().default(0n),
    status: withdrawalStatusEnum().notNull().default("requested"),
    txHash: text(),
    requestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp({ withTimezone: true }),
    submittedAt: timestamp({ withTimezone: true }),
    confirmedAt: timestamp({ withTimezone: true }),
    failureReason: text(),
    // 4-eyes actors. The DB constraint enforces approver != confirmer.
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
    submittedByUserId: uuid("submitted_by_user_id").references(() => users.id),
    confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id),
  },
  (t) => [
    check("withdrawals_amount_pos", sql`${t.amountMicro} > 0`),
    check("withdrawals_fee_nonneg", sql`${t.feeMicro} >= 0`),
    index("withdrawals_user_idx").on(t.userId, sql`${t.requestedAt} DESC`),
    index("withdrawals_status_idx")
      .on(t.status)
      .where(sql`${t.status} IN ('requested', 'approved', 'submitted')`),
  ],
);

export type Deposit = typeof deposits.$inferSelect;
export type DepositIntent = typeof depositIntents.$inferSelect;
export type Withdrawal = typeof withdrawals.$inferSelect;
