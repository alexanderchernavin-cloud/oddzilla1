// RiskZilla bot controls — the operator knobs behind the anti-automation
// gates on bet placement (migration 0097):
//
//   * placement intent token (required / TTL)
//   * minimum human confirm time (quote -> place)
//   * per-account velocity caps (bets / distinct matches per minute),
//     scaled by the bettor's risk score
//   * behaviour-score alert threshold (migration 0098)
//
// One singleton row, read on every placement and every intent issue, so
// it is memoised in-process for a few seconds. The admin PUT calls
// `invalidateBotControlsCache()` on the instance that served it; the TTL
// bounds staleness on any other instance. Postgres is the home for this
// state on purpose — production Redis is an LRU cache and has already
// evicted operator switches once (see migration 0095).

import { sql } from "drizzle-orm";
import type { DbClient } from "@oddzilla/db";

export interface BotControls {
  intentRequired: boolean;
  intentTtlSeconds: number;
  minHumanMs: number;
  velocityEnabled: boolean;
  maxBetsPerMinute: number;
  maxMatchesPerMinute: number;
  behaviourAlertThreshold: number;
  behaviourMinSessions: number;
  updatedAt: string;
  updatedBy: string | null;
}

// Mirrors the column DEFAULTs in 0097 — used when the singleton row is
// somehow missing so placement never hard-fails on a config read.
export const DEFAULT_BOT_CONTROLS: BotControls = {
  intentRequired: true,
  intentTtlSeconds: 120,
  minHumanMs: 600,
  velocityEnabled: true,
  maxBetsPerMinute: 12,
  maxMatchesPerMinute: 10,
  behaviourAlertThreshold: 0.7,
  behaviourMinSessions: 2,
  updatedAt: new Date(0).toISOString(),
  updatedBy: null,
};

const CACHE_TTL_MS = 5_000;
let cached: { at: number; value: BotControls } | null = null;

// Drizzle tx handle or the raw client — same shape engine.ts uses.
type SqlRunner = DbClient | Parameters<Parameters<DbClient["transaction"]>[0]>[0];

interface Row {
  intent_required: boolean;
  intent_ttl_seconds: number | string;
  min_human_ms: number | string;
  velocity_enabled: boolean;
  max_bets_per_minute: number | string;
  max_matches_per_minute: number | string;
  behaviour_alert_threshold: string;
  behaviour_min_sessions: number | string;
  updated_at: Date | string;
  updated_by: string | null;
}

function rowToControls(r: Row): BotControls {
  return {
    intentRequired: Boolean(r.intent_required),
    intentTtlSeconds: Number(r.intent_ttl_seconds),
    minHumanMs: Number(r.min_human_ms),
    velocityEnabled: Boolean(r.velocity_enabled),
    maxBetsPerMinute: Number(r.max_bets_per_minute),
    maxMatchesPerMinute: Number(r.max_matches_per_minute),
    behaviourAlertThreshold: Number(r.behaviour_alert_threshold),
    behaviourMinSessions: Number(r.behaviour_min_sessions),
    updatedAt:
      r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    updatedBy: r.updated_by,
  };
}

export async function loadBotControls(
  db: SqlRunner,
  opts: { fresh?: boolean } = {},
): Promise<BotControls> {
  if (!opts.fresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  const rows = (await db.execute(sql`
    SELECT intent_required, intent_ttl_seconds, min_human_ms,
           velocity_enabled, max_bets_per_minute, max_matches_per_minute,
           behaviour_alert_threshold, behaviour_min_sessions,
           updated_at, updated_by
      FROM riskzilla_bot_controls
     WHERE id = 1
     LIMIT 1
  `)) as unknown as Row[];
  const value = rows[0] ? rowToControls(rows[0]) : DEFAULT_BOT_CONTROLS;
  cached = { at: Date.now(), value };
  return value;
}

export function invalidateBotControlsCache(): void {
  cached = null;
}

// Effective per-minute cap for a bettor: the base cap scaled linearly by
// risk score, floored at 1 so a heavily dialled-down account can still
// place one bet a minute rather than none. Mirrors how the engine treats
// RS everywhere else — a linear multiplier with no automatic damping.
export function velocityCapFor(base: number, riskScore: number): number {
  const rs = Number.isFinite(riskScore) && riskScore > 0 ? riskScore : 1;
  return Math.max(1, Math.round(base * rs));
}
