// /admin/riskzilla/behaviour/* — automation alerts from the behaviour
// scoring rollup (migration 0098), plus per-bettor acknowledge / rescore.
// The per-bettor score itself is embedded in GET /admin/riskzilla/bettors
// (list) and /admin/riskzilla/bettors/:id (profile) — see bettors.ts.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { adminAuditLog } from "@oddzilla/db";
import { NotFoundError } from "../../../lib/errors.js";
import { loadBotControls } from "../../../lib/riskzilla/bot-controls.js";
import {
  loadBehaviourProfile,
  rescoreUser,
} from "../../../lib/riskzilla/behaviour-sweeper.js";

const alertsQuery = z.object({
  includeAcknowledged: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const idParams = z.object({ id: z.string().uuid() });

export interface BehaviourAlertDto {
  userId: string;
  email: string;
  nickname: string | null;
  riskScore: string;
  status: string;
  score: number | null;
  maxSessionScore: number | null;
  sessionsScored: number;
  alertSince: string | null;
  acknowledgedAt: string | null;
  scoredAt: string;
  reasons: string[];
}

function iso(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

export default async function riskzillaBehaviourRoutes(app: FastifyInstance) {
  app.get("/admin/riskzilla/behaviour/alerts", async (request) => {
    request.requireRole("admin");
    const q = alertsQuery.parse(request.query);
    const rows = (await app.db.execute(sql`
      SELECT b.user_id::text            AS user_id,
             u.email                    AS email,
             u.nickname                 AS nickname,
             u.risk_score::text         AS risk_score,
             u.status::text             AS status,
             b.score::float8            AS score,
             b.max_session_score::float8 AS max_session_score,
             b.sessions_scored          AS sessions_scored,
             b.alert_since              AS alert_since,
             b.acknowledged_at          AS acknowledged_at,
             b.scored_at                AS scored_at,
             b.features->'reasonCounts' AS reason_counts
        FROM bettor_behaviour_scores b
        JOIN users u ON u.id = b.user_id
       WHERE b.alert = TRUE
         ${q.includeAcknowledged ? sql`` : sql`AND b.acknowledged_at IS NULL`}
       ORDER BY b.acknowledged_at IS NOT NULL, b.score DESC NULLS LAST, b.alert_since DESC
       LIMIT ${q.limit}
    `)) as unknown as Array<{
      user_id: string;
      email: string;
      nickname: string | null;
      risk_score: string;
      status: string;
      score: number | string | null;
      max_session_score: number | string | null;
      sessions_scored: number | string;
      alert_since: Date | string | null;
      acknowledged_at: Date | string | null;
      scored_at: Date | string;
      reason_counts: Record<string, number> | string | null;
    }>;

    const entries: BehaviourAlertDto[] = rows.map((r) => {
      let counts: Record<string, number> = {};
      if (r.reason_counts && typeof r.reason_counts === "object") counts = r.reason_counts;
      else if (typeof r.reason_counts === "string") {
        try {
          counts = JSON.parse(r.reason_counts) as Record<string, number>;
        } catch {
          counts = {};
        }
      }
      const reasons = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([k]) => k);
      return {
        userId: r.user_id,
        email: r.email,
        nickname: r.nickname,
        riskScore: r.risk_score,
        status: r.status,
        score: r.score == null ? null : Number(r.score),
        maxSessionScore: r.max_session_score == null ? null : Number(r.max_session_score),
        sessionsScored: Number(r.sessions_scored),
        alertSince: iso(r.alert_since),
        acknowledgedAt: iso(r.acknowledged_at),
        scoredAt: iso(r.scored_at)!,
        reasons,
      };
    });
    return { entries };
  });

  app.post("/admin/riskzilla/bettors/:id/behaviour/acknowledge", async (request) => {
    const admin = request.requireRole("admin");
    const params = idParams.parse(request.params);
    const body = z.object({ undo: z.boolean().optional() }).parse(request.body ?? {});
    const undo = body.undo === true;

    const existing = (await app.db.execute(sql`
      SELECT alert, acknowledged_at FROM bettor_behaviour_scores
       WHERE user_id = ${params.id}::uuid LIMIT 1
    `)) as unknown as Array<{ alert: boolean; acknowledged_at: Date | string | null }>;
    if (!existing[0]) throw new NotFoundError("behaviour_not_scored", "behaviour_not_scored");

    await app.db.transaction(async (tx) => {
      if (undo) {
        await tx.execute(sql`
          UPDATE bettor_behaviour_scores
             SET acknowledged_at = NULL, acknowledged_by = NULL, updated_at = now()
           WHERE user_id = ${params.id}::uuid
        `);
      } else {
        await tx.execute(sql`
          UPDATE bettor_behaviour_scores
             SET acknowledged_at = now(), acknowledged_by = ${admin.id}::uuid, updated_at = now()
           WHERE user_id = ${params.id}::uuid
        `);
      }
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: undo
          ? "riskzilla.behaviour.unacknowledge"
          : "riskzilla.behaviour.acknowledge",
        targetType: "user",
        targetId: params.id,
        subjectUserId: params.id,
        beforeJson: { acknowledgedAt: iso(existing[0]!.acknowledged_at) },
        afterJson: { acknowledged: !undo },
        ipInet: request.ip ?? null,
      });
    });

    const controls = await loadBotControls(app.db);
    return { behaviour: await loadBehaviourProfile(app.db, params.id, controls) };
  });

  app.post("/admin/riskzilla/bettors/:id/behaviour/rescore", async (request) => {
    const admin = request.requireRole("admin");
    const params = idParams.parse(request.params);
    const controls = await loadBotControls(app.db, { fresh: true });
    await rescoreUser(app.db, params.id, controls);
    await app.db.insert(adminAuditLog).values({
      actorUserId: admin.id,
      action: "riskzilla.behaviour.rescore",
      targetType: "user",
      targetId: params.id,
      subjectUserId: params.id,
      beforeJson: null,
      afterJson: null,
      ipInet: request.ip ?? null,
    });
    return { behaviour: await loadBehaviourProfile(app.db, params.id, controls) };
  });
}
