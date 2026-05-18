import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  bigint,
  smallint,
  timestamp,
  char,
  boolean,
  numeric,
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
    ticketsPublic: boolean().notNull().default(true),
    nickname: citext().unique(),
    bio: text(),
    isAi: boolean().notNull().default(false),
    // RiskZilla per-bettor risk score (migration 0037). Multiplier on
    // the bettor's effective slice of match liability. 1 = neutral;
    // 0.01 = pariah; 10 = sharp / VIP.
    riskScore: numeric("risk_score", { precision: 4, scale: 3 })
      .notNull()
      .default("1.000"),
    // Equipped avatar template. NULL = no avatar (UI falls back to a
    // monogram). The FK is declared in the migration (with ON DELETE
    // SET NULL) rather than here to avoid a circular schema import
    // through avatar_templates.created_by → users.id. Drizzle doesn't
    // need the relation declared at the column level for query joins.
    avatarTemplateId: uuid(),
    // Sidebar sport ordering preference (migration 0056). NULL = render
    // the default order (TOP_SPORT_SLUGS pinned + alphabetical fallback);
    // non-null = user-saved slug order, with any sports missing from
    // the array appended in default order on the client.
    sportOrder: text("sport_order").array(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("users_status_idx").on(t.status),
    index("users_role_idx").on(t.role).where(sql`${t.role} <> 'user'`),
    check("users_global_limit_nonneg", sql`${t.globalLimitMicro} >= 0`),
    check("users_bet_delay_range", sql`${t.betDelaySeconds} >= 0 AND ${t.betDelaySeconds} <= 300`),
    check(
      "users_nickname_format",
      sql`${t.nickname} IS NULL OR ${t.nickname} ~ '^[A-Za-z0-9_]{3,20}$'`,
    ),
    check("users_bio_length", sql`${t.bio} IS NULL OR length(${t.bio}) <= 280`),
    // Migration 0030: defensive cap (matches the TS zod limit of 320).
    // Existing rows are unaffected — Postgres validates only on
    // INSERT/UPDATE and every prior email is well below this.
    check(
      "users_email_length_chk",
      sql`char_length(${t.email}) BETWEEN 3 AND 320`,
    ),
    check(
      "users_risk_score_range",
      sql`${t.riskScore} >= 0.01 AND ${t.riskScore} <= 10`,
    ),
    check(
      "users_sport_order_len",
      sql`${t.sportOrder} IS NULL OR array_length(${t.sportOrder}, 1) <= 100`,
    ),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
