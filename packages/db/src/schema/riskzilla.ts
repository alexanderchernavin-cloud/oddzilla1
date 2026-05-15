// RiskZilla — internal Risk Management Service tables. See
// migration 0037_riskzilla.sql for the full design.

import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  bigserial,
  bigint,
  smallint,
  integer,
  text,
  uuid,
  numeric,
  jsonb,
  timestamp,
  char,
  check,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { matches, sports, tournaments } from "./catalog.js";
import { tickets } from "./tickets.js";

// ── Enums ──────────────────────────────────────────────────────────────
// `bet_loss` / `bet_payout` / `bet_refund` are kept in the enum for
// historical audit rows but new code stops writing them after
// migration 0049 — bet outcomes don't move crypto, only redistribute
// it between bettor wallets and the operator's profit pool.
// `deposit_credit` and `withdrawal_debit` (added in migration 0048)
// are the new cash-flow event types.
export const riskzillaBankLedgerTypeEnum = pgEnum(
  "riskzilla_bank_ledger_type",
  [
    "seed",
    "bet_loss",
    "bet_payout",
    "bet_refund",
    "manual_adjust",
    "deposit_credit",
    "withdrawal_debit",
  ],
);

export const riskzillaDecisionEnum = pgEnum("riskzilla_decision", [
  "accepted",
  "rejected_min_stake",
  "rejected_max_payout",
  "rejected_match_liability",
  "rejected_bet_factor",
  "rejected_bank_limit",
  "rejected_user_blocked",
  "rejected_market_factor",
]);

// ── Per-tier defaults ──────────────────────────────────────────────────
// tier 0 = global fallback. 1..6 mirror Oddin's tournaments.risk_tier.
export const riskzillaSettings = pgTable(
  "riskzilla_settings",
  {
    tier: smallint().primaryKey(),
    matchLiabilityMicro: bigint("match_liability_micro", { mode: "bigint" }).notNull(),
    minBetMicro: bigint("min_bet_micro", { mode: "bigint" }).notNull(),
    maxPayoutMicro: bigint("max_payout_micro", { mode: "bigint" }).notNull(),
    betFactor: numeric("bet_factor", { precision: 5, scale: 4 })
      .notNull()
      .default("0.1000"),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("riskzilla_settings_tier_range", sql`${t.tier} >= 0 AND ${t.tier} <= 32`),
    check("riskzilla_settings_match_liability_pos", sql`${t.matchLiabilityMicro} > 0`),
    check("riskzilla_settings_min_bet_pos", sql`${t.minBetMicro} > 0`),
    check("riskzilla_settings_max_payout_pos", sql`${t.maxPayoutMicro} > 0`),
    check(
      "riskzilla_settings_bet_factor_range",
      sql`${t.betFactor} > 0 AND ${t.betFactor} <= 1.0000`,
    ),
  ],
);

// ── Per-market multiplier ──────────────────────────────────────────────
// Down-only multiplier on per-market liability charge. Keyed by Oddin's
// providerMarketId so one row applies across every match.
export const riskzillaMarketFactors = pgTable(
  "riskzilla_market_factors",
  {
    providerMarketId: integer("provider_market_id").primaryKey(),
    factor: numeric({ precision: 4, scale: 3 }).notNull().default("1.000"),
    label: text().notNull(),
    notes: text(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "riskzilla_market_factors_factor_range",
      sql`${t.factor} >= 0.000 AND ${t.factor} <= 1.000`,
    ),
  ],
);

// ── Bank state (singleton) ─────────────────────────────────────────────
export const riskzillaBankState = pgTable(
  "riskzilla_bank_state",
  {
    id: text().primaryKey().default("default"),
    bankLimitMicro: bigint("bank_limit_micro", { mode: "bigint" })
      .notNull()
      .default(100000000000n),
    openLiabilityMicro: bigint("open_liability_micro", { mode: "bigint" })
      .notNull()
      .default(0n),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("riskzilla_bank_state_singleton", sql`${t.id} = 'default'`),
    check("riskzilla_bank_state_limit_nonneg", sql`${t.bankLimitMicro} >= 0`),
    check("riskzilla_bank_state_open_nonneg", sql`${t.openLiabilityMicro} >= 0`),
  ],
);

// ── Bank ledger ────────────────────────────────────────────────────────
export const riskzillaBankLedger = pgTable(
  "riskzilla_bank_ledger",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    deltaMicro: bigint("delta_micro", { mode: "bigint" }).notNull(),
    type: riskzillaBankLedgerTypeEnum().notNull(),
    refType: text("ref_type"),
    refId: text("ref_id"),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    memo: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("riskzilla_bank_ledger_ref_unique")
      .on(t.type, t.refType, t.refId)
      .where(sql`${t.refId} IS NOT NULL`),
    index("riskzilla_bank_ledger_created_idx").on(sql`${t.createdAt} DESC`),
  ],
);

// ── Decision event log ─────────────────────────────────────────────────
export const riskzillaEventLog = pgTable(
  "riskzilla_event_log",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    userId: uuid("user_id").notNull().references(() => users.id),
    decision: riskzillaDecisionEnum().notNull(),
    reasonMessage: text("reason_message"),
    currency: char({ length: 4 }).notNull(),
    stakeMicro: bigint("stake_micro", { mode: "bigint" }).notNull(),
    potentialPayoutMicro: bigint("potential_payout_micro", { mode: "bigint" }).notNull(),
    matchId: bigint("match_id", { mode: "bigint" }).references(() => matches.id, {
      onDelete: "set null",
    }),
    sportId: integer("sport_id").references(() => sports.id, { onDelete: "set null" }),
    tournamentId: integer("tournament_id").references(() => tournaments.id, {
      onDelete: "set null",
    }),
    riskTier: smallint("risk_tier"),
    rsAtDecision: numeric("rs_at_decision", { precision: 4, scale: 3 }).notNull(),
    bankAtDecisionMicro: bigint("bank_at_decision_micro", { mode: "bigint" }).notNull(),
    decisionMeta: jsonb("decision_meta").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("riskzilla_event_log_created_idx").on(sql`${t.createdAt} DESC`),
    index("riskzilla_event_log_user_idx").on(t.userId, sql`${t.createdAt} DESC`),
    index("riskzilla_event_log_match_idx").on(t.matchId, sql`${t.createdAt} DESC`),
    index("riskzilla_event_log_decision_idx").on(t.decision, sql`${t.createdAt} DESC`),
    index("riskzilla_event_log_ticket_idx")
      .on(t.ticketId)
      .where(sql`${t.ticketId} IS NOT NULL`),
  ],
);

// ── Live bet acceptance delay (migration 0052) ─────────────────────────
// Per-(global, sport, tournament, match) override of how long a LIVE
// placement sits in pending_delay before the bet-delay worker promotes
// or rejects it. At placement the engine resolves per-leg via
// match > tournament > sport > global, takes MAX across all live legs,
// then takes MAX with the per-user users.bet_delay_seconds. Pure-prematch
// placements bypass the cascade (cascade contributes 0).
export const liveDelayScopeEnum = pgEnum("live_delay_scope", [
  "global",
  "sport",
  "tournament",
  "match",
]);

export const riskzillaLiveDelayConfig = pgTable(
  "riskzilla_live_delay_config",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    scope: liveDelayScopeEnum().notNull(),
    sportId: integer("sport_id").references(() => sports.id, { onDelete: "cascade" }),
    tournamentId: integer("tournament_id").references(() => tournaments.id, {
      onDelete: "cascade",
    }),
    matchId: bigint("match_id", { mode: "bigint" }).references(() => matches.id, {
      onDelete: "cascade",
    }),
    delaySeconds: smallint("delay_seconds").notNull(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "riskzilla_live_delay_seconds_range",
      sql`${t.delaySeconds} >= 0 AND ${t.delaySeconds} <= 300`,
    ),
    check(
      "riskzilla_live_delay_scope_consistency",
      sql`(${t.scope} = 'global'
            AND ${t.sportId} IS NULL AND ${t.tournamentId} IS NULL AND ${t.matchId} IS NULL)
        OR (${t.scope} = 'sport'
            AND ${t.sportId} IS NOT NULL AND ${t.tournamentId} IS NULL AND ${t.matchId} IS NULL)
        OR (${t.scope} = 'tournament'
            AND ${t.sportId} IS NULL AND ${t.tournamentId} IS NOT NULL AND ${t.matchId} IS NULL)
        OR (${t.scope} = 'match'
            AND ${t.sportId} IS NULL AND ${t.tournamentId} IS NULL AND ${t.matchId} IS NOT NULL)`,
    ),
    uniqueIndex("riskzilla_live_delay_global_unique")
      .on(sql`(${t.scope} = 'global')`)
      .where(sql`${t.scope} = 'global'`),
    uniqueIndex("riskzilla_live_delay_sport_unique")
      .on(t.sportId)
      .where(sql`${t.scope} = 'sport'`),
    uniqueIndex("riskzilla_live_delay_tournament_unique")
      .on(t.tournamentId)
      .where(sql`${t.scope} = 'tournament'`),
    uniqueIndex("riskzilla_live_delay_match_unique")
      .on(t.matchId)
      .where(sql`${t.scope} = 'match'`),
  ],
);

export type RiskzillaLiveDelayConfig = typeof riskzillaLiveDelayConfig.$inferSelect;

export type RiskzillaSettings = typeof riskzillaSettings.$inferSelect;
export type RiskzillaMarketFactor = typeof riskzillaMarketFactors.$inferSelect;
export type RiskzillaBankState = typeof riskzillaBankState.$inferSelect;
export type RiskzillaBankLedgerEntry = typeof riskzillaBankLedger.$inferSelect;
export type RiskzillaEventLogEntry = typeof riskzillaEventLog.$inferSelect;
