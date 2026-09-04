// RiskZilla behaviour sweeper (migration 0098).
//
// Every 5 minutes, under a Redis NX lock (same shape as the analytics
// retention sweep), score signed-in analytics sessions that have new data
// and roll the results up per bettor into `bettor_behaviour_scores`.
// Nothing here touches the placement hot path: POST /bets only ever reads
// the precomputed per-user row, and this job reads data the tracker has
// already persisted.
//
// Cost model: a session is one indexed read of its mouse batches (≤400)
// and click events (≤2000) plus a single linear pass — an hour of
// continuous pointer movement is under 30k points. 200 sessions per
// sweep is milliseconds of CPU and a handful of small queries.
//
// The scoring itself is pure and unit-tested in behaviour-score.ts.

import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { DbClient } from "@oddzilla/db";
import {
  combineUserScore,
  resolveAlert,
  scoreSession,
  type ClickSample,
  type MouseSample,
  type SessionSignals,
} from "./behaviour-score.js";
import { loadBotControls, type BotControls } from "./bot-controls.js";

type SqlRunner = DbClient | Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const SWEEP_BOOT_DELAY_MS = 2 * 60 * 1000;
const LOCK_KEY = "riskzilla:behaviour:lock";
const LOCK_TTL_S = 4 * 60;
const SESSIONS_PER_SWEEP = 200;
// A session still receiving flushes is left alone until it has been
// quiet for this long, so we score it once instead of on every tick.
const SETTLE_SECONDS = 120;
const MAX_BATCHES_PER_SESSION = 400;
const MAX_CLICKS_PER_SESSION = 2000;
const ROLLUP_WINDOW_DAYS = 30;
const CONFIRM_SAMPLE_TICKETS = 200;
// A confirm inside min_human_ms + this slack counts as "as fast as the
// rules allow" for the confirm-time signal.
const FAST_CONFIRM_SLACK_MS = 150;

export interface BehaviourSweeperHandle {
  close(): void;
}

export interface BehaviourProfileDto {
  score: number | null;
  maxSessionScore: number | null;
  sessionsScored: number;
  sessionsInsufficient: number;
  pendingSessions: number;
  features: Record<string, unknown>;
  alert: boolean;
  alertSince: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  scoredAt: string | null;
  threshold: number;
  minSessions: number;
}

interface PendingSession {
  id: string;
  user_id: string;
  viewport_w: number | string | null;
}

function toMs(v: Date | string | number): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return new Date(v).getTime();
}

function toIso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function selectPendingSessions(
  db: SqlRunner,
  opts: { limit: number; userId?: string; settle: boolean },
): Promise<PendingSession[]> {
  return (await db.execute(sql`
    SELECT id::text AS id, user_id::text AS user_id, viewport_w
      FROM analytics_sessions
     WHERE user_id IS NOT NULL
       AND (behaviour_scored_at IS NULL OR last_seen_at > behaviour_scored_at)
       ${opts.settle ? sql`AND last_seen_at < now() - make_interval(secs => ${SETTLE_SECONDS})` : sql``}
       ${opts.userId ? sql`AND user_id = ${opts.userId}::uuid` : sql``}
     ORDER BY last_seen_at DESC
     LIMIT ${opts.limit}
  `)) as unknown as PendingSession[];
}

async function loadSignals(
  db: SqlRunner,
  sessionId: string,
  viewportW: number | string | null,
): Promise<SessionSignals> {
  const batches = (await db.execute(sql`
    SELECT started_at, points
      FROM analytics_mouse_batches
     WHERE session_id = ${sessionId}::uuid
     ORDER BY seq ASC
     LIMIT ${MAX_BATCHES_PER_SESSION}
  `)) as unknown as Array<{ started_at: Date | string; points: unknown }>;
  const segments: MouseSample[][] = [];
  for (const b of batches) {
    const t0 = toMs(b.started_at);
    const pts = Array.isArray(b.points) ? (b.points as unknown[]) : [];
    const seg: MouseSample[] = [];
    for (const p of pts) {
      if (!Array.isArray(p) || p.length < 3) continue;
      const dt = Number(p[0]);
      const x = Number(p[1]);
      const y = Number(p[2]);
      if (!Number.isFinite(dt) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      seg.push({ t: t0 + dt, x, y });
    }
    if (seg.length > 0) segments.push(seg);
  }

  const clickRows = (await db.execute(sql`
    SELECT occurred_at, payload->>'x' AS x, payload->>'y' AS y
      FROM analytics_events
     WHERE session_id = ${sessionId}::uuid AND kind = 'click'
     ORDER BY seq ASC
     LIMIT ${MAX_CLICKS_PER_SESSION}
  `)) as unknown as Array<{ occurred_at: Date | string; x: string | null; y: string | null }>;
  const clicks: ClickSample[] = clickRows.map((r) => ({
    t: toMs(r.occurred_at),
    x: numOrNull(r.x),
    y: numOrNull(r.y),
  }));

  return { segments, clicks, viewportW: numOrNull(viewportW) };
}

// Score one session and persist the result on its analytics row.
export async function scoreOneSession(db: SqlRunner, s: PendingSession): Promise<void> {
  const signals = await loadSignals(db, s.id, s.viewport_w);
  const { features, result } = scoreSession(signals);
  const stored = { ...features, components: result.components, reasons: result.reasons };
  await db.execute(sql`
    UPDATE analytics_sessions
       SET behaviour_score = ${result.score == null ? null : result.score.toFixed(3)},
           behaviour_features = ${JSON.stringify(stored)}::jsonb,
           behaviour_scored_at = now()
     WHERE id = ${s.id}::uuid
  `);
}

interface RollupRow {
  scored: number | string;
  insufficient: number | string;
  max_score: number | string | null;
  sessions: Array<{ score: number; points: number }> | string | null;
  avg_straightness: number | string | null;
  avg_speed_cv: number | string | null;
  avg_heading_entropy: number | string | null;
  avg_clicks_without_approach: number | string | null;
  avg_click_interval_cv: number | string | null;
  reasons: string[] | string | null;
  confirm_n: number | string;
  confirm_fast: number | string;
  confirm_median_ms: number | string | null;
  confirm_min_ms: number | string | null;
}

function parseJsonMaybe<T>(v: T | string | null): T | null {
  if (v == null) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v;
}

// Recompute a bettor's rollup from their scored sessions (last 30 days)
// and confirm-time history, then upsert `bettor_behaviour_scores`.
// Returns the new alert state, or null when there was nothing to score.
export async function rollupUser(
  db: SqlRunner,
  userId: string,
  controls: BotControls,
): Promise<{ score: number | null; alert: boolean } | null> {
  const fastCutoff = controls.minHumanMs + FAST_CONFIRM_SLACK_MS;
  const rows = (await db.execute(sql`
    WITH s AS (
      SELECT behaviour_score::float8 AS score,
             COALESCE((behaviour_features->>'points')::int, 0) AS points,
             behaviour_features AS f
        FROM analytics_sessions
       WHERE user_id = ${userId}::uuid
         AND behaviour_scored_at IS NOT NULL
         AND last_seen_at >= now() - make_interval(days => ${ROLLUP_WINDOW_DAYS})
    ), scored AS (
      SELECT * FROM s WHERE score IS NOT NULL
    ), c AS (
      SELECT quote_to_place_ms
        FROM tickets
       WHERE user_id = ${userId}::uuid AND quote_to_place_ms IS NOT NULL
       ORDER BY placed_at DESC
       LIMIT ${CONFIRM_SAMPLE_TICKETS}
    )
    SELECT
      (SELECT COUNT(*) FROM scored)::int                                   AS scored,
      (SELECT COUNT(*) FROM s WHERE score IS NULL)::int                    AS insufficient,
      (SELECT MAX(score) FROM scored)::float8                              AS max_score,
      (SELECT COALESCE(json_agg(json_build_object('score', score, 'points', points)), '[]'::json)
         FROM scored)                                                      AS sessions,
      (SELECT AVG((f->>'straightness')::float8) FROM scored)::float8        AS avg_straightness,
      (SELECT AVG((f->>'speedCv')::float8) FROM scored)::float8             AS avg_speed_cv,
      (SELECT AVG((f->>'headingEntropy')::float8) FROM scored)::float8      AS avg_heading_entropy,
      (SELECT AVG((f->>'clicksWithoutApproach')::float8) FROM scored)::float8
                                                                           AS avg_clicks_without_approach,
      (SELECT AVG((f->>'clickIntervalCv')::float8) FROM scored)::float8     AS avg_click_interval_cv,
      (SELECT COALESCE(json_agg(r), '[]'::json)
         FROM scored, jsonb_array_elements_text(COALESCE(f->'reasons', '[]'::jsonb)) AS r)
                                                                           AS reasons,
      (SELECT COUNT(*) FROM c)::int                                        AS confirm_n,
      (SELECT COUNT(*) FILTER (WHERE quote_to_place_ms < ${fastCutoff}) FROM c)::int
                                                                           AS confirm_fast,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY quote_to_place_ms) FROM c)::float8
                                                                           AS confirm_median_ms,
      (SELECT MIN(quote_to_place_ms) FROM c)::int                          AS confirm_min_ms
  `)) as unknown as RollupRow[];
  const r = rows[0];
  if (!r) return null;

  const scoredN = Number(r.scored);
  const insufficientN = Number(r.insufficient);
  const confirmN = Number(r.confirm_n);
  if (scoredN === 0 && insufficientN === 0 && confirmN === 0) return null;

  const sessions = (parseJsonMaybe(r.sessions) ?? []).map((s) => ({
    score: Number(s.score),
    points: Number(s.points),
  }));
  const confirm =
    confirmN > 0 ? { n: confirmN, fastShare: Number(r.confirm_fast) / confirmN } : null;
  const score = combineUserScore(sessions, confirm);

  const existing = (await db.execute(sql`
    SELECT alert FROM bettor_behaviour_scores WHERE user_id = ${userId}::uuid LIMIT 1
  `)) as unknown as Array<{ alert: boolean }>;
  const wasAlert = Boolean(existing[0]?.alert);
  const alert = resolveAlert({
    score,
    sessionsScored: scoredN,
    threshold: controls.behaviourAlertThreshold,
    minSessions: controls.behaviourMinSessions,
    wasAlert,
  });

  const reasonList = parseJsonMaybe(r.reasons) ?? [];
  const reasonCounts: Record<string, number> = {};
  for (const reason of reasonList) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;

  const features = {
    avgStraightness: numOrNull(r.avg_straightness),
    avgSpeedCv: numOrNull(r.avg_speed_cv),
    avgHeadingEntropy: numOrNull(r.avg_heading_entropy),
    avgClicksWithoutApproach: numOrNull(r.avg_clicks_without_approach),
    avgClickIntervalCv: numOrNull(r.avg_click_interval_cv),
    reasonCounts,
    confirm: {
      n: confirmN,
      fast: Number(r.confirm_fast),
      fastShare: confirm?.fastShare ?? null,
      medianMs: numOrNull(r.confirm_median_ms),
      minMs: numOrNull(r.confirm_min_ms),
      fastCutoffMs: fastCutoff,
    },
    windowDays: ROLLUP_WINDOW_DAYS,
  };

  await db.execute(sql`
    INSERT INTO bettor_behaviour_scores
      (user_id, score, max_session_score, sessions_scored, sessions_insufficient,
       features, alert, alert_since, scored_at, updated_at)
    VALUES
      (${userId}::uuid,
       ${score == null ? null : score.toFixed(3)},
       ${r.max_score == null ? null : Number(r.max_score).toFixed(3)},
       ${scoredN}, ${insufficientN},
       ${JSON.stringify(features)}::jsonb,
       ${alert},
       ${alert ? sql`now()` : sql`NULL`},
       now(), now())
    ON CONFLICT (user_id) DO UPDATE SET
      score                 = EXCLUDED.score,
      max_session_score     = EXCLUDED.max_session_score,
      sessions_scored       = EXCLUDED.sessions_scored,
      sessions_insufficient = EXCLUDED.sessions_insufficient,
      features              = EXCLUDED.features,
      alert                 = EXCLUDED.alert,
      -- Keep the original raise time while the alert holds; clear when it drops.
      alert_since           = CASE WHEN EXCLUDED.alert
                                   THEN COALESCE(bettor_behaviour_scores.alert_since, now())
                                   ELSE NULL END,
      -- A freshly raised alert needs a fresh acknowledgement.
      acknowledged_at       = CASE WHEN EXCLUDED.alert AND NOT bettor_behaviour_scores.alert
                                   THEN NULL ELSE bettor_behaviour_scores.acknowledged_at END,
      acknowledged_by       = CASE WHEN EXCLUDED.alert AND NOT bettor_behaviour_scores.alert
                                   THEN NULL ELSE bettor_behaviour_scores.acknowledged_by END,
      scored_at             = now(),
      updated_at            = now()
  `);
  return { score, alert };
}

// On-demand path for the admin "Rescore now" button: score every pending
// session for one bettor (settled or not) and roll them up.
export async function rescoreUser(
  db: SqlRunner,
  userId: string,
  controls: BotControls,
): Promise<void> {
  const pending = await selectPendingSessions(db, { limit: 500, userId, settle: false });
  for (const s of pending) await scoreOneSession(db, s);
  await rollupUser(db, userId, controls);
}

export async function loadBehaviourProfile(
  db: SqlRunner,
  userId: string,
  controls: BotControls,
): Promise<BehaviourProfileDto> {
  const rows = (await db.execute(sql`
    SELECT score::text AS score, max_session_score::text AS max_session_score,
           sessions_scored, sessions_insufficient, features,
           alert, alert_since, acknowledged_at, acknowledged_by::text AS acknowledged_by,
           scored_at
      FROM bettor_behaviour_scores
     WHERE user_id = ${userId}::uuid
     LIMIT 1
  `)) as unknown as Array<{
    score: string | null;
    max_session_score: string | null;
    sessions_scored: number | string;
    sessions_insufficient: number | string;
    features: Record<string, unknown> | string | null;
    alert: boolean;
    alert_since: Date | string | null;
    acknowledged_at: Date | string | null;
    acknowledged_by: string | null;
    scored_at: Date | string;
  }>;
  const pendingRows = (await db.execute(sql`
    SELECT COUNT(*)::int AS n
      FROM analytics_sessions
     WHERE user_id = ${userId}::uuid
       AND (behaviour_scored_at IS NULL OR last_seen_at > behaviour_scored_at)
  `)) as unknown as Array<{ n: number | string }>;
  const pendingSessions = Number(pendingRows[0]?.n ?? 0);
  const r = rows[0];
  if (!r) {
    return {
      score: null,
      maxSessionScore: null,
      sessionsScored: 0,
      sessionsInsufficient: 0,
      pendingSessions,
      features: {},
      alert: false,
      alertSince: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
      scoredAt: null,
      threshold: controls.behaviourAlertThreshold,
      minSessions: controls.behaviourMinSessions,
    };
  }
  return {
    score: numOrNull(r.score),
    maxSessionScore: numOrNull(r.max_session_score),
    sessionsScored: Number(r.sessions_scored),
    sessionsInsufficient: Number(r.sessions_insufficient),
    pendingSessions,
    features: parseJsonMaybe(r.features) ?? {},
    alert: Boolean(r.alert),
    alertSince: toIso(r.alert_since),
    acknowledgedAt: toIso(r.acknowledged_at),
    acknowledgedBy: r.acknowledged_by,
    scoredAt: toIso(r.scored_at),
    threshold: controls.behaviourAlertThreshold,
    minSessions: controls.behaviourMinSessions,
  };
}

export function startBehaviourScoringSweeper(app: FastifyInstance): BehaviourSweeperHandle {
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

      const controls = await loadBotControls(app.db, { fresh: true });
      const pending = await selectPendingSessions(app.db, {
        limit: SESSIONS_PER_SWEEP,
        settle: true,
      });
      const users = new Set<string>();
      let scored = 0;
      for (const s of pending) {
        try {
          await scoreOneSession(app.db, s);
          scored += 1;
          users.add(s.user_id);
        } catch (err) {
          app.log.warn(
            { err, sessionId: s.id, component: "riskzilla-behaviour" },
            "behaviour session scoring failed",
          );
        }
      }
      let alerts = 0;
      for (const userId of users) {
        try {
          const r = await rollupUser(app.db, userId, controls);
          if (r?.alert) alerts += 1;
        } catch (err) {
          app.log.warn(
            { err, userId, component: "riskzilla-behaviour" },
            "behaviour rollup failed",
          );
        }
      }
      if (scored > 0) {
        app.log.info(
          {
            component: "riskzilla-behaviour",
            sessionsScored: scored,
            usersRolledUp: users.size,
            alertsActive: alerts,
          },
          "behaviour scoring sweep complete",
        );
      }
    } catch (err) {
      app.log.error({ err, component: "riskzilla-behaviour" }, "behaviour scoring sweep failed");
    } finally {
      if (locked) {
        try {
          await app.redis.del(LOCK_KEY);
        } catch {
          // TTL releases it.
        }
      }
    }
  };

  const bootTimer = setTimeout(() => void sweep(), SWEEP_BOOT_DELAY_MS);
  bootTimer.unref?.();
  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  timer.unref?.();

  return {
    close() {
      clearTimeout(bootTimer);
      clearInterval(timer);
    },
  };
}
