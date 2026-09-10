// SlotZilla — the 15-second live-basketball slot game (migration
// 20260909T211312_slotzilla; the wallet_tx_type values it writes are in
// 20260909T211311). Design and measurements: docs/SLOTZILLA.md.
//
//   sr_live_events       Sportradar's play-by-play, keyed on THEIR event
//                        id. Audit trail behind every settled spin and
//                        the calibration corpus. match_id nullable:
//                        archived corpus games have no fixture of ours.
//   slotzilla_config     singleton (id = 'default'): the switch, the
//                        currencies, and every number the operator
//                        controls (return target, stake bounds, caps,
//                        lead / grace seconds).
//   slotzilla_paytables  named paytables; `lines` maps line key ->
//                        multiplier in HUNDREDTHS. Exactly one active.
//   slotzilla_games      one row per fixture the game runs on, with the
//                        clock as last read and the return-monitor totals.
//   slotzilla_spins      a spin is a bet and a round in one row.
//
// Column names rely on the global `casing: "snake_case"` setting in
// packages/db/src/index.ts.

import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { matches } from "./catalog.js";
import { users } from "./users.js";

export const srLiveEvents = pgTable(
  "sr_live_events",
  {
    srEventId: bigint({ mode: "bigint" }).primaryKey(),
    srMatchId: bigint({ mode: "bigint" }).notNull(),
    matchId: bigint({ mode: "bigint" }).references(() => matches.id, {
      onDelete: "set null",
    }),
    type: text().notNull(),
    // Derived once at insert (P3 / P2 / FT / MISS / FOUL), NULL when the
    // event makes no symbol.
    symbol: text(),
    team: text(),
    points: smallint(),
    // Cumulative match-clock second the scout logged the event at.
    seconds: integer().notNull(),
    uts: bigint({ mode: "bigint" }).notNull(),
    updatedUts: bigint({ mode: "bigint" }).notNull(),
    disabled: boolean().notNull().default(false),
    period: smallint(),
    playerId: bigint({ mode: "bigint" }),
    playerName: text(),
    raw: jsonb().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "sr_live_events_symbol_check",
      sql`${t.symbol} IS NULL OR ${t.symbol} IN ('P3', 'P2', 'FT', 'MISS', 'FOUL')`,
    ),
    check("sr_live_events_team_check", sql`${t.team} IS NULL OR ${t.team} IN ('home', 'away')`),
    index("sr_live_events_match_seconds_idx").on(t.srMatchId, t.seconds),
    index("sr_live_events_created_idx").on(t.createdAt),
  ],
);

export type SrLiveEvent = typeof srLiveEvents.$inferSelect;

export const SLOTZILLA_SINGLETON_ID = "default";

export const slotzillaConfig = pgTable(
  "slotzilla_config",
  {
    id: text().primaryKey().default(SLOTZILLA_SINGLETON_ID),
    enabled: boolean().notNull().default(false),
    currencies: text().array().notNull().default(sql`'{OZ}'::text[]`),
    rtpTargetBp: integer().notNull().default(9700),
    leadSeconds: integer().notNull().default(10),
    clockPastSeconds: integer().notNull().default(5),
    graceSeconds: integer().notNull().default(10),
    feedDarkVoidSeconds: integer().notNull().default(180),
    minStakeMicro: bigint({ mode: "bigint" }).notNull().default(100_000n),
    maxStakeMicro: bigint({ mode: "bigint" }).notNull().default(50_000_000n),
    maxPayoutMicro: bigint({ mode: "bigint" }).notNull().default(500_000_000n),
    matchLiabilityCapMicro: bigint({ mode: "bigint" }).notNull().default(5_000_000_000n),
    returnAlarmMarginBp: integer().notNull().default(1000),
    returnAlarmMinSpins: integer().notNull().default(200),
    autoplayEnabled: boolean().notNull().default(true),
    updatedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("slotzilla_config_singleton", sql`${t.id} = 'default'`),
    check("slotzilla_config_rtp_range", sql`${t.rtpTargetBp} BETWEEN 5000 AND 9900`),
    check("slotzilla_config_lead_range", sql`${t.leadSeconds} BETWEEN 5 AND 60`),
    check("slotzilla_config_grace_range", sql`${t.graceSeconds} BETWEEN 0 AND 120`),
    check("slotzilla_config_clock_past_range", sql`${t.clockPastSeconds} BETWEEN 0 AND 60`),
    check("slotzilla_config_dark_range", sql`${t.feedDarkVoidSeconds} BETWEEN 30 AND 3600`),
    check(
      "slotzilla_config_stake_order",
      sql`${t.minStakeMicro} > 0 AND ${t.maxStakeMicro} >= ${t.minStakeMicro}`,
    ),
    check(
      "slotzilla_config_caps_positive",
      sql`${t.maxPayoutMicro} > 0 AND ${t.matchLiabilityCapMicro} > 0`,
    ),
    check(
      "slotzilla_config_currencies_check",
      sql`${t.currencies} <@ ARRAY['USDC', 'OZ']::text[]`,
    ),
  ],
);

export type SlotzillaConfig = typeof slotzillaConfig.$inferSelect;

export const slotzillaPaytables = pgTable(
  "slotzilla_paytables",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    name: text().notNull(),
    // Line key -> multiplier in hundredths (50 = x0.5, 3500 = x35).
    lines: jsonb().$type<Record<string, number>>().notNull(),
    fittedRtpBp: integer(),
    corpusNote: text(),
    active: boolean().notNull().default(false),
    updatedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("slotzilla_paytables_name_check", sql`length(${t.name}) BETWEEN 1 AND 80`),
    uniqueIndex("slotzilla_paytables_active_uniq").on(sql`(true)`).where(sql`${t.active}`),
  ],
);

export type SlotzillaPaytable = typeof slotzillaPaytables.$inferSelect;

export const SLOTZILLA_GAME_STATUSES = ["scheduled", "live", "paused", "ended", "voided"] as const;
export type SlotzillaGameStatusRow = (typeof SLOTZILLA_GAME_STATUSES)[number];

export const slotzillaGames = pgTable(
  "slotzilla_games",
  {
    matchId: bigint({ mode: "bigint" })
      .primaryKey()
      .references(() => matches.id, { onDelete: "cascade" }),
    srMatchId: bigint({ mode: "bigint" }).notNull(),
    status: text().$type<SlotzillaGameStatusRow>().notNull().default("scheduled"),
    coverageLevel: smallint(),
    paytableId: bigint({ mode: "bigint" }).references(() => slotzillaPaytables.id, {
      onDelete: "set null",
    }),
    clockSeconds: integer(),
    clockRunning: boolean().notNull().default(false),
    clockPeriod: smallint(),
    clockReadAt: timestamp({ withTimezone: true }),
    feedLagMs: integer(),
    lastEventAt: timestamp({ withTimezone: true }),
    spinsCount: integer().notNull().default(0),
    usdcStakeMicro: bigint({ mode: "bigint" }).notNull().default(0n),
    usdcPayoutMicro: bigint({ mode: "bigint" }).notNull().default(0n),
    ozStakeMicro: bigint({ mode: "bigint" }).notNull().default(0n),
    ozPayoutMicro: bigint({ mode: "bigint" }).notNull().default(0n),
    pausedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    pausedAt: timestamp({ withTimezone: true }),
    note: text(),
    // A looping recorded fixture (migration 20260910T082030). The loop is
    // perfectly predictable once seen, so placement hard-gates these to OZ
    // in code — never real money, and never a config flag that could open
    // it. `demoEpoch` anchors cycle 0; the cycle LENGTH is derived from the
    // recording at runtime rather than stored, so it cannot disagree with
    // the events it describes.
    isDemo: boolean().notNull().default(false),
    demoEpoch: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "slotzilla_games_status_check",
      sql`${t.status} IN ('scheduled', 'live', 'paused', 'ended', 'voided')`,
    ),
    index("slotzilla_games_status_idx").on(t.status),
  ],
);

export type SlotzillaGame = typeof slotzillaGames.$inferSelect;

export const SLOTZILLA_SPIN_STATUSES = ["open", "won", "lost", "void"] as const;
export type SlotzillaSpinStatusRow = (typeof SLOTZILLA_SPIN_STATUSES)[number];

export const slotzillaSpins = pgTable(
  "slotzilla_spins",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    matchId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => slotzillaGames.matchId),
    currency: char({ length: 4 }).notNull(),
    stakeMicro: bigint({ mode: "bigint" }).notNull(),
    exposureMicro: bigint({ mode: "bigint" }).notNull(),
    paytableId: bigint({ mode: "bigint" })
      .notNull()
      .references(() => slotzillaPaytables.id),
    // First window's match-clock second; windows are +0, +5, +10.
    windowFrom: integer().notNull(),
    reels: text().array(),
    reelTeams: text().array(),
    reelEventIds: bigint({ mode: "bigint" }).array(),
    lineKey: text(),
    multiplierX100: integer(),
    payoutMicro: bigint({ mode: "bigint" }).notNull().default(0n),
    status: text().$type<SlotzillaSpinStatusRow>().notNull().default("open"),
    voidReason: text(),
    autoplay: boolean().notNull().default(false),
    idempotencyKey: text(),
    placedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    check("slotzilla_spins_status_check", sql`${t.status} IN ('open', 'won', 'lost', 'void')`),
    check("slotzilla_spins_stake_positive", sql`${t.stakeMicro} > 0`),
    check("slotzilla_spins_exposure_nonneg", sql`${t.exposureMicro} >= 0`),
    check("slotzilla_spins_payout_nonneg", sql`${t.payoutMicro} >= 0`),
    check(
      "slotzilla_spins_window_grid",
      sql`${t.windowFrom} >= 0 AND ${t.windowFrom} % 5 = 0`,
    ),
    check(
      "slotzilla_spins_reels_shape",
      sql`${t.reels} IS NULL OR cardinality(${t.reels}) = 3`,
    ),
    check(
      "slotzilla_spins_settled_shape",
      sql`(${t.status} = 'open' AND ${t.settledAt} IS NULL AND ${t.reels} IS NULL)
        OR (${t.status} IN ('won', 'lost') AND ${t.settledAt} IS NOT NULL AND ${t.reels} IS NOT NULL)
        OR (${t.status} = 'void' AND ${t.settledAt} IS NOT NULL)`,
    ),
    uniqueIndex("slotzilla_spins_one_open_uniq")
      .on(t.userId, t.matchId)
      .where(sql`${t.status} = 'open'`),
    uniqueIndex("slotzilla_spins_idempotency_uniq")
      .on(t.userId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    index("slotzilla_spins_open_idx")
      .on(t.matchId, t.windowFrom)
      .where(sql`${t.status} = 'open'`),
    index("slotzilla_spins_user_idx").on(t.userId, sql`${t.placedAt} DESC`),
  ],
);

export type SlotzillaSpin = typeof slotzillaSpins.$inferSelect;
