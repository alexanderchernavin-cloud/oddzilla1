import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  bigint,
  smallint,
  timestamp,
  char,
  index,
  check,
  customType,
} from "drizzle-orm/pg-core";
import { userStatusEnum, userRoleEnum, kycStatusEnum } from "../enums.js";

const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey().defaultRandom(),
    email: citext().notNull().unique(),
    passwordHash: text().notNull(),
    status: userStatusEnum().notNull().default("active"),
    role: userRoleEnum().notNull().default("user"),
    kycStatus: kycStatusEnum().notNull().default("none"),
    countryCode: char({ length: 2 }),
    globalLimitMicro: bigint({ mode: "bigint" }).notNull().default(0n),
    betDelaySeconds: smallint().notNull().default(0),
    displayName: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("users_status_idx").on(t.status),
    index("users_role_idx").on(t.role).where(sql`${t.role} <> 'user'`),
    check("users_global_limit_nonneg", sql`${t.globalLimitMicro} >= 0`),
    check("users_bet_delay_range", sql`${t.betDelaySeconds} >= 0 AND ${t.betDelaySeconds} <= 300`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
