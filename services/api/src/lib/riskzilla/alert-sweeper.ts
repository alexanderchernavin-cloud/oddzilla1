// Alert center sweeper (migration 0105). Every minute, Redis-lock
// guarded so a multi-instance api runs one sweep per tick: loads the
// enabled rules from risk_alert_rules, runs each rule's candidate
// SELECT as an INSERT into risk_alerts, and writes a `created` event
// for every row that is new. A condition that is already open bumps
// occurrences / last_seen_at through ON CONFLICT; a condition that was
// resolved is filtered out by the NOT EXISTS gate and never re-fires
// under the same key.
//
// Off the placement hot path entirely. Rule SQL lives in
// alert-rules.ts; this file only orchestrates.

import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { DbClient } from "@oddzilla/db";
import { ALERT_RULES, readParams, type AlertSeverity } from "./alert-rules.js";

const SWEEP_INTERVAL_MS = 60 * 1000;
const SWEEP_BOOT_DELAY_MS = 20 * 1000;
const LOCK_KEY = "riskzilla:alerts:lock";
const LOCK_TTL_S = 50;

export interface AlertSweeperHandle {
  close(): void;
}

export interface SweepResult {
  ran: number;
  inserted: number;
  bumped: number;
  failed: string[];
  durationMs: number;
}

interface RuleRow {
  kind: string;
  enabled: boolean;
  severity: AlertSeverity;
  params: unknown;
}

export async function runAlertSweep(db: DbClient, log?: FastifyInstance["log"]): Promise<SweepResult> {
  const started = Date.now();
  const rows = (await db.execute(sql`
    SELECT kind, enabled, severity::text AS severity, params
      FROM risk_alert_rules
  `)) as unknown as RuleRow[];
  const stored = new Map(rows.map((r) => [r.kind, r]));

  let inserted = 0;
  let bumped = 0;
  let ran = 0;
  const failed: string[] = [];

  for (const def of ALERT_RULES) {
    const row = stored.get(def.kind);
    // A rule missing from the table (added in code before its seed
    // migration landed) is skipped rather than evaluated with defaults —
    // the FK from risk_alerts.kind would reject the insert anyway.
    if (!row || !row.enabled) continue;
    const params = readParams(def, row.params);
    ran += 1;
    try {
      const result = (await db.execute(sql`
        WITH upserted AS (
          INSERT INTO risk_alerts
            (kind, severity, title, body, dedupe_key, subject_user_id, ticket_id,
             match_id, currency, amount_micro, payload)
          SELECT ${def.kind}::text, ${row.severity}::risk_alert_severity,
                 left(c.title, 200), left(c.body, 2000), c.dedupe_key, c.subject_user_id,
                 c.ticket_id, c.match_id, c.currency, c.amount_micro, c.payload
            FROM (${def.select(params)}) c
           WHERE NOT EXISTS (
             SELECT 1 FROM risk_alerts ra
              WHERE ra.dedupe_key = c.dedupe_key AND ra.status = 'resolved'
           )
          ON CONFLICT (dedupe_key) WHERE status <> 'resolved'
          DO UPDATE SET
            last_seen_at = NOW(),
            -- The sweep runs every minute, so a condition that simply
            -- persists would count up once a minute. Count a repeat only
            -- when the alert was last seen over an hour ago: occurrences
            -- then reads as "distinct hours the condition was observed".
            occurrences  = risk_alerts.occurrences
                           + CASE WHEN risk_alerts.last_seen_at < NOW() - interval '1 hour'
                                  THEN 1 ELSE 0 END,
            title        = EXCLUDED.title,
            body         = EXCLUDED.body,
            amount_micro = EXCLUDED.amount_micro,
            payload      = EXCLUDED.payload,
            updated_at   = NOW()
          RETURNING id, (xmax = 0) AS inserted
        ),
        created_events AS (
          INSERT INTO risk_alert_events (alert_id, kind, meta)
          SELECT id, 'created', jsonb_build_object('rule', ${def.kind}::text)
            FROM upserted WHERE inserted
          RETURNING 1
        )
        SELECT
          COUNT(*) FILTER (WHERE inserted)::int     AS inserted,
          COUNT(*) FILTER (WHERE NOT inserted)::int AS bumped
        FROM upserted
      `)) as unknown as Array<{ inserted: number; bumped: number }>;
      inserted += Number(result[0]?.inserted ?? 0);
      bumped += Number(result[0]?.bumped ?? 0);
    } catch (err) {
      failed.push(def.kind);
      log?.warn({ err, rule: def.kind, component: "riskzilla-alerts" }, "alert rule failed");
    }
  }

  return { ran, inserted, bumped, failed, durationMs: Date.now() - started };
}

export function startAlertSweeper(app: FastifyInstance): AlertSweeperHandle {
  const sweep = async () => {
    let locked = false;
    try {
      const acquired = await app.redis.set(
        LOCK_KEY,
        `${process.pid}:${Date.now()}`,
        "EX",
        LOCK_TTL_S,
        "NX",
      );
      if (!acquired) return;
      locked = true;
      const r = await runAlertSweep(app.db, app.log);
      if (r.inserted > 0 || r.failed.length > 0) {
        app.log.info(
          { component: "riskzilla-alerts", event: "alert.sweep", ...r },
          "alert sweep complete",
        );
      }
    } catch (err) {
      app.log.error({ err, component: "riskzilla-alerts" }, "alert sweep failed");
    } finally {
      if (locked) {
        try {
          await app.redis.del(LOCK_KEY);
        } catch {
          // Lock expires on its own.
        }
      }
    }
  };

  const boot = setTimeout(() => void sweep(), SWEEP_BOOT_DELAY_MS);
  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  return {
    close() {
      clearTimeout(boot);
      clearInterval(timer);
    },
  };
}
