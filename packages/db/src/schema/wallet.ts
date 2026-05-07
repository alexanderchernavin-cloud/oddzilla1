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
  primaryKey,
} from "drizzle-orm/pg-core";
import { walletTxTypeEnum } from "../enums.js";
import { users } from "./users.js";

// One wallet row per (user, currency). USDC is the production currency
// (migration 0032 renamed from USDT); OZ is a demo currency for testing
// bet flows. See migrations 0014 + 0032.
export const wallets = pgTable(
  "wallets",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    currency: char({ length: 4 }).notNull().default("USDC"),
    balanceMicro: bigint({ mode: "bigint" }).notNull().default(0n),
    lockedMicro: bigint({ mode: "bigint" }).notNull().default(0n),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.currency] }),
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
    currency: char({ length: 4 }).notNull().default("USDC"),
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
    // Migration 0030: per-user-per-currency time-ordered scan, used by
    // /wallet/ledger?currency=X and admin per-user PnL.
    index("wallet_ledger_user_currency_ts_idx").on(
      t.userId,
      t.currency,
      sql`${t.createdAt} DESC`,
    ),
    // Migration 0030: dashboard PnL aggregation. Partial — only the
    // three financial types — so the index stays small.
    index("wallet_ledger_pnl_idx")
      .on(sql`${t.createdAt} DESC`, t.type, t.currency)
      .where(sql`${t.type} IN ('bet_stake', 'bet_payout', 'bet_refund')`),
  ],
);

export type Wallet = typeof wallets.$inferSelect;
export type WalletLedgerEntry = typeof walletLedger.$inferSelect;
