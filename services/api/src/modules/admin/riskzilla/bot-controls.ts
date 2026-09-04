// /admin/riskzilla/bot-controls — the operator knobs behind the
// anti-automation gates on POST /bets (migration 0097): placement intent
// token, minimum human confirm time, per-account velocity caps, and the
// behaviour-score alert threshold. Singleton row; every PUT is
// audit-logged and invalidates the in-process memo.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { adminAuditLog } from "@oddzilla/db";
import {
  invalidateBotControlsCache,
  loadBotControls,
  type BotControls,
} from "../../../lib/riskzilla/bot-controls.js";

const putBody = z.object({
  intentRequired: z.boolean(),
  intentTtlSeconds: z.number().int().min(15).max(900),
  minHumanMs: z.number().int().min(0).max(10_000),
  velocityEnabled: z.boolean(),
  maxBetsPerMinute: z.number().int().min(1).max(1000),
  maxMatchesPerMinute: z.number().int().min(1).max(1000),
  behaviourAlertThreshold: z.number().gt(0).max(1),
  behaviourMinSessions: z.number().int().min(1).max(100),
});

function toAudit(c: BotControls): Record<string, unknown> {
  return {
    intentRequired: c.intentRequired,
    intentTtlSeconds: c.intentTtlSeconds,
    minHumanMs: c.minHumanMs,
    velocityEnabled: c.velocityEnabled,
    maxBetsPerMinute: c.maxBetsPerMinute,
    maxMatchesPerMinute: c.maxMatchesPerMinute,
    behaviourAlertThreshold: c.behaviourAlertThreshold,
    behaviourMinSessions: c.behaviourMinSessions,
  };
}

export default async function riskzillaBotControlsRoutes(app: FastifyInstance) {
  app.get("/admin/riskzilla/bot-controls", async (request) => {
    request.requireRole("admin");
    return loadBotControls(app.db, { fresh: true });
  });

  app.put("/admin/riskzilla/bot-controls", async (request) => {
    const admin = request.requireRole("admin");
    const body = putBody.parse(request.body);
    const before = await loadBotControls(app.db, { fresh: true });

    await app.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO riskzilla_bot_controls
          (id, intent_required, intent_ttl_seconds, min_human_ms,
           velocity_enabled, max_bets_per_minute, max_matches_per_minute,
           behaviour_alert_threshold, behaviour_min_sessions,
           updated_by, updated_at)
        VALUES
          (1, ${body.intentRequired}, ${body.intentTtlSeconds}, ${body.minHumanMs},
           ${body.velocityEnabled}, ${body.maxBetsPerMinute}, ${body.maxMatchesPerMinute},
           ${body.behaviourAlertThreshold.toFixed(3)}, ${body.behaviourMinSessions},
           ${admin.id}::uuid, now())
        ON CONFLICT (id) DO UPDATE SET
          intent_required           = EXCLUDED.intent_required,
          intent_ttl_seconds        = EXCLUDED.intent_ttl_seconds,
          min_human_ms              = EXCLUDED.min_human_ms,
          velocity_enabled          = EXCLUDED.velocity_enabled,
          max_bets_per_minute       = EXCLUDED.max_bets_per_minute,
          max_matches_per_minute    = EXCLUDED.max_matches_per_minute,
          behaviour_alert_threshold = EXCLUDED.behaviour_alert_threshold,
          behaviour_min_sessions    = EXCLUDED.behaviour_min_sessions,
          updated_by                = EXCLUDED.updated_by,
          updated_at                = now()
      `);
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "riskzilla.bot_controls.update",
        targetType: "riskzilla_bot_controls",
        targetId: "1",
        beforeJson: toAudit(before),
        afterJson: {
          ...body,
          behaviourAlertThreshold: Number(body.behaviourAlertThreshold.toFixed(3)),
        },
        ipInet: request.ip ?? null,
      });
    });

    invalidateBotControlsCache();
    return loadBotControls(app.db, { fresh: true });
  });
}
