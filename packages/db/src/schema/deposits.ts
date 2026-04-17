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
import { chainNetworkEnum, depositStatusEnum, withdrawalStatusEnum } from "../enums.js";
import { users } from "./users.js";

export const depositAddresses = pgTable(
  "deposit_addresses",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    network: chainNetworkEnum().notNull(),
    address: text().notNull(),
    derivationPath: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("deposit_addresses_network_addr").on(t.network, t.address),
    unique("deposit_addresses_user_network").on(t.userId, t.network),
  ],
);

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

export type DepositAddress = typeof depositAddresses.$inferSelect;
export type Deposit = typeof deposits.$inferSelect;
export type Withdrawal = typeof withdrawals.$inferSelect;
