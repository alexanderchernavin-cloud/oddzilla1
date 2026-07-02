import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  jsonb,
  index,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

// First-party FE analytics (migration 0083). Storefront behaviour
// capture — sessions, journey events (page views / clicks in exact seq
// order), and sampled mouse trails. Self-hosted: no third-party vendor
// sees bettor traffic. Retention is enforced by an hourly sweep in the
// api service (90 d sessions + events, 14 d mouse batches).

export const analyticsSessions = pgTable(
  "analytics_sessions",
  {
    // Client-generated (sessionStorage) so a session spans SSR
    // navigations without a server round-trip at start.
    id: uuid().primaryKey(),
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull(),
    entryPath: text(),
    exitPath: text(),
    referrer: text(),
    userAgent: text(),
    viewportW: integer(),
    viewportH: integer(),
    // Denormalised counters bumped per flush so KPI/list queries never
    // aggregate the events table per session row.
    pageViewCount: integer().notNull().default(0),
    clickCount: integer().notNull().default(0),
    eventCount: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("analytics_sessions_started_idx").on(t.startedAt.desc()),
    index("analytics_sessions_user_idx")
      .on(t.userId, t.startedAt.desc())
      .where(sql`${t.userId} IS NOT NULL`),
    index("analytics_sessions_last_seen_idx").on(t.lastSeenAt),
    check("analytics_sessions_seen_after_start", sql`${t.lastSeenAt} >= ${t.startedAt}`),
  ],
);

export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: bigint({ mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey(),
    sessionId: uuid()
      .notNull()
      .references(() => analyticsSessions.id, { onDelete: "cascade" }),
    // Client-side monotonic counter per session: exact journey order +
    // apply-once under batch re-delivery (pagehide can fire both the
    // keepalive fetch AND sendBeacon).
    seq: integer().notNull(),
    // Open TEXT on purpose — new event kinds must not need a migration
    // (same rationale as zillapass_tasks.predicate_key). The API layer
    // validates with zod.
    kind: text().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    path: text(),
    section: text(),
    payload: jsonb(),
  },
  (t) => [
    unique("analytics_events_session_seq_unique").on(t.sessionId, t.seq),
    index("analytics_events_time_idx").on(t.occurredAt),
    index("analytics_events_kind_time_idx").on(t.kind, t.occurredAt),
  ],
);

export const analyticsMouseBatches = pgTable(
  "analytics_mouse_batches",
  {
    id: bigint({ mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey(),
    sessionId: uuid()
      .notNull()
      .references(() => analyticsSessions.id, { onDelete: "cascade" }),
    // Shares the per-session counter space with analytics_events.seq —
    // one monotonic client-side stream keeps ordering trivial.
    seq: integer().notNull(),
    path: text().notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    durationMs: integer().notNull(),
    viewportW: integer(),
    viewportH: integer(),
    pointCount: integer().notNull(),
    // [[dtMs, x, y], ...] — dt relative to startedAt, x/y viewport px.
    points: jsonb().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("analytics_mouse_batches_session_seq_unique").on(t.sessionId, t.seq),
    index("analytics_mouse_batches_session_idx").on(t.sessionId, t.startedAt),
    index("analytics_mouse_batches_created_idx").on(t.createdAt),
    check(
      "analytics_mouse_batches_point_count_range",
      sql`${t.pointCount} BETWEEN 1 AND 1000`,
    ),
  ],
);

export type AnalyticsSession = typeof analyticsSessions.$inferSelect;
export type AnalyticsEvent = typeof analyticsEvents.$inferSelect;
export type AnalyticsMouseBatch = typeof analyticsMouseBatches.$inferSelect;
