import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  smallint,
  numeric,
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
    // When the watcher rejects an intent because the user sent a non-USDC
    // token to the receive address, the contract + raw amount land here
    // so admin can see "100 USDT @ 0xdAC1..." instead of "no_usdc_transfer".
    // amount_raw is uint256-shaped because the unknown token's decimals
    // are not necessarily 6 — apply token_decimals (if known) on render.
    detectedTokenContract: text("detected_token_contract"),
    detectedTokenAmountRaw: numeric("detected_token_amount_raw", { precision: 78, scale: 0 }),
    // Admin acknowledgement for the wrong-token alert. When this is
    // non-null, the row stops counting toward the sidebar badge.
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedByUserId: uuid("acknowledged_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
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
    index("deposit_intents_wrong_token_unack_idx")
      .on(sql`${t.submittedAt} DESC`)
      .where(sql`${t.failureReason} = 'wrong_token' AND ${t.acknowledgedAt} IS NULL`),
  ],
);

// Every ERC20 Transfer to the receive address whose contract isn't USDC.
// Filled by wallet-watcher's wider eth_getLogs scan (topics filter on
// the recipient address only, no contract filter), so it catches the
// "user sent the wrong coin AND didn't paste a hash" case the
// intent-rejection path can't reach. Admin acks per-row; partial index
// powers the unacked-count badge.
export const unattributedDeposits = pgTable(
  "unattributed_deposits",
  {
    id: uuid().primaryKey().defaultRandom(),
    network: chainNetworkEnum().notNull().default("ERC20"),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    blockHash: text("block_hash").notNull(),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    tokenContract: text("token_contract").notNull(),
    tokenSymbol: text("token_symbol"),
    tokenDecimals: smallint("token_decimals"),
    amountRaw: numeric("amount_raw", { precision: 78, scale: 0 }).notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedByUserId: uuid("acknowledged_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    note: text(),
  },
  (t) => [
    unique("unattributed_deposits_unique").on(t.network, t.txHash, t.logIndex),
    check("unattributed_deposits_amount_pos", sql`${t.amountRaw} > 0`),
    check(
      "unattributed_deposits_decimals_range",
      sql`${t.tokenDecimals} IS NULL OR (${t.tokenDecimals} >= 0 AND ${t.tokenDecimals} <= 36)`,
    ),
    index("unattributed_deposits_unack_idx")
      .on(sql`${t.detectedAt} DESC`)
      .where(sql`${t.acknowledgedAt} IS NULL`),
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

// Per-user from-address whitelist (migration 0033). Lets the
// wallet-watcher attribute Transfers to the shared receive address
// without the user pasting a tx hash. Address is stored lowercase;
// the API normalises on insert.
export const userWalletAddresses = pgTable(
  "user_wallet_addresses",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    network: chainNetworkEnum().notNull().default("ERC20"),
    address: text().notNull(),
    label: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("user_wallet_addresses_addr_unique").on(t.network, t.address),
    check(
      "user_wallet_addresses_addr_format",
      sql`${t.address} ~ '^0x[0-9a-f]{40}$'`,
    ),
    index("user_wallet_addresses_user_idx").on(t.userId, sql`${t.createdAt} DESC`),
  ],
);

export type Deposit = typeof deposits.$inferSelect;
export type DepositIntent = typeof depositIntents.$inferSelect;
export type Withdrawal = typeof withdrawals.$inferSelect;
export type UserWalletAddress = typeof userWalletAddresses.$inferSelect;
export type UnattributedDeposit = typeof unattributedDeposits.$inferSelect;
