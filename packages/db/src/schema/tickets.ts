import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  bigserial,
  bigint,
  text,
  numeric,
  timestamp,
  inet,
  unique,
  index,
  check,
} from "drizzle-orm/pg-core";
import { ticketStatusEnum, betTypeEnum, outcomeResultEnum } from "../enums.js";
import { users } from "./users.js";
import { markets } from "./markets.js";

export const tickets = pgTable(
  "tickets",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    status: ticketStatusEnum().notNull().default("pending_delay"),
    betType: betTypeEnum().notNull().default("single"),
    stakeMicro: bigint({ mode: "bigint" }).notNull(),
    potentialPayoutMicro: bigint({ mode: "bigint" }).notNull(),
    actualPayoutMicro: bigint({ mode: "bigint" }),
    idempotencyKey: text().notNull().unique(),
    notBeforeTs: timestamp({ withTimezone: true }),
    rejectReason: text(),
    placedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp({ withTimezone: true }),
    settledAt: timestamp({ withTimezone: true }),
    clientIp: inet(),
    userAgent: text(),
  },
  (t) => [
    check("tickets_stake_pos", sql`${t.stakeMicro} > 0`),
    check("tickets_potential_nonneg", sql`${t.potentialPayoutMicro} >= 0`),
    index("tickets_user_status_idx").on(t.userId, t.status, sql`${t.placedAt} DESC`),
    index("tickets_pending_delay_idx")
      .on(t.notBeforeTs)
      .where(sql`${t.status} = 'pending_delay'`),
    index("tickets_open_idx").on(t.status).where(sql`${t.status} IN ('accepted', 'pending_delay')`),
  ],
);

export const ticketSelections = pgTable(
  "ticket_selections",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    ticketId: uuid()
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    marketId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => markets.id),
    outcomeId: text().notNull(),
    oddsAtPlacement: numeric({ precision: 10, scale: 4 }).notNull(),
    result: outcomeResultEnum(),
    voidFactor: numeric({ precision: 4, scale: 3 }),
    settledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique("ticket_selections_unique").on(t.ticketId, t.marketId, t.outcomeId),
    index("ticket_selections_market_idx").on(t.marketId).where(sql`${t.result} IS NULL`),
  ],
);

export type Ticket = typeof tickets.$inferSelect;
export type TicketSelection = typeof ticketSelections.$inferSelect;
