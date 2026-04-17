import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  char,
  bigint,
  bigserial,
  text,
  timestamp,
  check,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { walletTxTypeEnum } from "../enums.js";
import { users } from "./users.js";

export const wallets = pgTable(
  "wallets",
  {
    userId: uuid()
      .primaryKey()
      .references(() => users.id, { onDelete: "restrict" }),
    currency: char({ length: 4 }).notNull().default("USDT"),
    balanceMicro: bigint({ mode: "bigint" }).notNull().default(0n),
    lockedMicro: bigint({ mode: "bigint" }).notNull().default(0n),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("wallets_balance_nonneg", sql`${t.balanceMicro} >= 0`),
    check("wallets_locked_nonneg", sql`${t.lockedMicro} >= 0`),
    check("wallets_balance_ge_locked", sql`${t.balanceMicro} >= ${t.lockedMicro}`),
  ],
);

export const walletLedger = pgTable(
  "wallet_ledger",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    deltaMicro: bigint({ mode: "bigint" }).notNull(),
    type: walletTxTypeEnum().notNull(),
    refType: text(),
    refId: text(),
    txHash: text(),
    memo: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("wallet_ledger_user_idx").on(t.userId, sql`${t.createdAt} DESC`),
    index("wallet_ledger_ref_idx").on(t.refType, t.refId),
    uniqueIndex("wallet_ledger_unique_ref")
      .on(t.type, t.refType, t.refId)
      .where(sql`${t.refId} IS NOT NULL`),
  ],
);

export type Wallet = typeof wallets.$inferSelect;
export type WalletLedgerEntry = typeof walletLedger.$inferSelect;
