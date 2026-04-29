import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  uuid,
  bigint,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  jsonb,
  unique,
  index,
  check,
} from "drizzle-orm/pg-core";
import { oddsScopeEnum, cashoutStatusEnum } from "../enums.js";
import { users } from "./users.js";
import { tickets } from "./tickets.js";

export const cashoutConfig = pgTable(
  "cashout_config",
  {
    id: serial().primaryKey(),
    scope: oddsScopeEnum().notNull(),
    scopeRefId: text(),
    enabled: boolean().notNull().default(true),
    prematchFullPaybackSeconds: integer().notNull().default(0),
    deductionLadderJson: jsonb(),
    minOfferMicro: bigint({ mode: "bigint" }).notNull().default(0n),
    minValueChangeBp: integer().notNull().default(0),
    acceptanceDelaySeconds: integer().notNull().default(5),
    updatedBy: uuid().references(() => users.id),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("cashout_config_scope").on(t.scope, t.scopeRefId),
    check(
      "cashout_config_prematch_range",
      sql`${t.prematchFullPaybackSeconds} BETWEEN 0 AND 86400`,
    ),
    check(
      "cashout_config_min_offer_nonneg",
      sql`${t.minOfferMicro} >= 0`,
    ),
    check(
      "cashout_config_min_change_range",
      sql`${t.minValueChangeBp} BETWEEN 0 AND 10000`,
    ),
    check(
      "cashout_config_acceptance_delay_range",
      sql`${t.acceptanceDelaySeconds} BETWEEN 0 AND 60`,
    ),
  ],
);

export const cashouts = pgTable(
  "cashouts",
  {
    id: uuid().primaryKey().defaultRandom(),
    ticketId: uuid()
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    status: cashoutStatusEnum().notNull().default("offered"),
    offeredMicro: bigint({ mode: "bigint" }).notNull(),
    payoutMicro: bigint({ mode: "bigint" }),
    ticketOddsSnapshot: numeric({ precision: 20, scale: 4 }).notNull(),
    probabilitySnapshot: numeric({ precision: 20, scale: 18 }).notNull(),
    deductionFactorSnapshot: numeric({ precision: 8, scale: 4 }),
    reason: text(),
    requestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedAt: timestamp({ withTimezone: true }),
    executedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("cashouts_ticket_idx").on(t.ticketId, sql`${t.requestedAt} DESC`),
    index("cashouts_user_idx").on(t.userId, sql`${t.requestedAt} DESC`),
    check("cashouts_offered_nonneg", sql`${t.offeredMicro} >= 0`),
    check(
      "cashouts_payout_nonneg",
      sql`${t.payoutMicro} IS NULL OR ${t.payoutMicro} >= 0`,
    ),
  ],
);

export type CashoutConfig = typeof cashoutConfig.$inferSelect;
export type Cashout = typeof cashouts.$inferSelect;
