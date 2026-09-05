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
  uniqueIndex,
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
    // Email is no longer GLOBALLY unique — see migration 0065. Two
    // partial unique indexes below scope uniqueness per role-namespace
    // (`role='user'` = bettor; `role IN ('admin','support')` = admin),
    // so one email can own a bettor row AND an admin row. The auth
    // layer filters by namespace based on the request host.
    email: citext().notNull(),
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
    // Per-bettor hidden-sports preference (migration 0072). NULL or
    // empty array = no sports hidden; non-null = slugs that should be
    // filtered out of every storefront surface (sidebar, match lists,
    // ZillaFlash, CombiBoost suggestions). Companion to sportOrder;
    // hidden slugs still surface in the sidebar's edit mode so the
    // bettor can unhide them.
    hiddenSports: text("hidden_sports").array(),
    // Email verification (migration 0073). NULL = unverified; non-null
    // = the moment the user clicked the verify link. The storefront
    // surfaces a banner while NULL. Login still works regardless so
    // existing demo-OZ accounts aren't locked out on the rollout.
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    // Free-text operator notes (migration 0075). Surfaced on the
    // RiskZilla bettor page so the risk team can pin context — "VIP,
    // contacted on 2026-05-20 about deposit limits", "self-reported
    // problem gambling, watch closely", etc. NULL = no notes. Capped
    // at 4000 chars (DB CHECK) so a runaway paste can't bloat the row.
    notes: text(),
    // Operator labels (migration 0104): closed vocabulary shared with
    // packages/types/src/bettor-labels.ts and enforced by the CHECK
    // below. Descriptive only — the placement path never reads them.
    labels: text().array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("users_status_idx").on(t.status),
    index("users_role_idx").on(t.role).where(sql`${t.role} <> 'user'`),
    // Per-namespace email uniqueness (migration 0065). Splits the
    // global UNIQUE(email) the table launched with so the same email
    // can own one bettor row AND one admin row.
    uniqueIndex("users_email_bettor_uniq")
      .on(t.email)
      .where(sql`${t.role} = 'user'`),
    uniqueIndex("users_email_admin_uniq")
      .on(t.email)
      .where(sql`${t.role} IN ('admin', 'support')`),
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
    check(
      "users_hidden_sports_len",
      sql`${t.hiddenSports} IS NULL OR array_length(${t.hiddenSports}, 1) <= 100`,
    ),
    check(
      "users_notes_length",
      sql`${t.notes} IS NULL OR length(${t.notes}) <= 4000`,
    ),
    check(
      "users_labels_allowed",
      sql`${t.labels} <@ ARRAY['vip', 'sharp', 'regular', 'fraud', 'shady', 'suspicious', 'prematch', 'live']::text[]
        AND COALESCE(array_length(${t.labels}, 1), 0) <= 8`,
    ),
    index("users_labels_gin_idx")
      .using("gin", t.labels)
      .where(sql`${t.role} = 'user'`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
