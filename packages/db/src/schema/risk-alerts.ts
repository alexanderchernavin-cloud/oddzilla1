// Alert center (migration 0105). One queue every risk signal lands in,
// with a support-ticket lifecycle: open -> acknowledged -> resolved,
// an assignee and an append-only event trail. Rules and their
// thresholds live in risk_alert_rules; the sweeper in
// services/api/src/lib/riskzilla/alert-sweeper.ts evaluates them once a
// minute. Advisory only — nothing in the placement path reads these.

import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  bigserial,
  bigint,
  boolean,
  integer,
  text,
  uuid,
  char,
  jsonb,
  timestamp,
  check,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { tickets } from "./tickets.js";
import { matches } from "./catalog.js";

export const riskAlertSeverityEnum = pgEnum("risk_alert_severity", [
  "critical",
  "serious",
  "warning",
]);

export const riskAlertStatusEnum = pgEnum("risk_alert_status", [
  "open",
  "acknowledged",
  "resolved",
]);

export const riskAlertRules = pgTable(
  "risk_alert_rules",
  {
    kind: text().primaryKey(),
    enabled: boolean().notNull().default(true),
    severity: riskAlertSeverityEnum().notNull(),
    params: jsonb().notNull().default(sql`'{}'::jsonb`),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("risk_alert_rules_kind_format", sql`${t.kind} ~ '^[a-z_]{3,40}$'`)],
);

export const riskAlerts = pgTable(
  "risk_alerts",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    kind: text()
      .notNull()
      .references(() => riskAlertRules.kind, { onDelete: "restrict" }),
    severity: riskAlertSeverityEnum().notNull(),
    status: riskAlertStatusEnum().notNull().default("open"),
    title: text().notNull(),
    body: text(),
    dedupeKey: text("dedupe_key").notNull(),
    subjectUserId: uuid("subject_user_id").references(() => users.id, { onDelete: "set null" }),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    matchId: bigint("match_id", { mode: "bigint" }).references(() => matches.id, {
      onDelete: "set null",
    }),
    currency: char({ length: 4 }),
    amountMicro: bigint("amount_micro", { mode: "bigint" }),
    payload: jsonb().notNull().default(sql`'{}'::jsonb`),
    assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: uuid("acknowledged_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolution: text(),
    occurrences: integer().notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("risk_alerts_title_length", sql`char_length(${t.title}) BETWEEN 1 AND 200`),
    check("risk_alerts_body_length", sql`${t.body} IS NULL OR char_length(${t.body}) <= 2000`),
    check(
      "risk_alerts_resolution_length",
      sql`${t.resolution} IS NULL OR char_length(${t.resolution}) <= 2000`,
    ),
    check("risk_alerts_dedupe_length", sql`char_length(${t.dedupeKey}) BETWEEN 3 AND 200`),
    check("risk_alerts_occurrences_pos", sql`${t.occurrences} >= 1`),
    check(
      "risk_alerts_resolved_consistency",
      sql`(${t.status} = 'resolved') = (${t.resolvedAt} IS NOT NULL)`,
    ),
    uniqueIndex("risk_alerts_dedupe_active")
      .on(t.dedupeKey)
      .where(sql`${t.status} <> 'resolved'`),
    index("risk_alerts_dedupe_idx").on(t.dedupeKey),
    index("risk_alerts_queue_idx")
      .on(t.severity, sql`${t.lastSeenAt} DESC`)
      .where(sql`${t.status} <> 'resolved'`),
    index("risk_alerts_status_idx").on(t.status, sql`${t.lastSeenAt} DESC`),
    index("risk_alerts_subject_idx")
      .on(t.subjectUserId, sql`${t.createdAt} DESC`)
      .where(sql`${t.subjectUserId} IS NOT NULL`),
    index("risk_alerts_assignee_idx")
      .on(t.assignedTo)
      .where(sql`${t.assignedTo} IS NOT NULL AND ${t.status} <> 'resolved'`),
  ],
);

export const riskAlertEvents = pgTable(
  "risk_alert_events",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    alertId: bigint("alert_id", { mode: "bigint" })
      .notNull()
      .references(() => riskAlerts.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    note: text(),
    meta: jsonb().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "risk_alert_events_kind",
      sql`${t.kind} IN ('created', 'acknowledged', 'assigned', 'comment', 'resolved', 'reopened', 'escalated')`,
    ),
    check("risk_alert_events_note_length", sql`${t.note} IS NULL OR char_length(${t.note}) <= 2000`),
    index("risk_alert_events_alert_idx").on(t.alertId, t.id),
  ],
);

export type RiskAlertRule = typeof riskAlertRules.$inferSelect;
export type RiskAlert = typeof riskAlerts.$inferSelect;
export type RiskAlertEvent = typeof riskAlertEvents.$inferSelect;
