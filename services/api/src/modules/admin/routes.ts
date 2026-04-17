// Admin endpoints. All routes require role='admin' and write an
// admin_audit_log entry on every mutation.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { mappingReviewQueue, adminAuditLog } from "@oddzilla/db";
import {
  NotFoundError,
  BadRequestError,
} from "../../lib/errors.js";

const listQuery = z.object({
  status: z.enum(["pending", "approved", "rejected"]).default("pending"),
  entityType: z.enum(["sport", "category", "tournament", "match", "market_type"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const reviewBody = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(500).optional(),
});

export default async function adminRoutes(app: FastifyInstance) {
  // ── Mapping review queue ─────────────────────────────────────────────
  app.get("/admin/mapping", async (request) => {
    request.requireRole("admin");
    const q = listQuery.parse(request.query);

    const whereClause = q.entityType
      ? and(eq(mappingReviewQueue.status, q.status), eq(mappingReviewQueue.entityType, q.entityType))
      : eq(mappingReviewQueue.status, q.status);

    const rows = await app.db
      .select()
      .from(mappingReviewQueue)
      .where(whereClause)
      .orderBy(sql`${mappingReviewQueue.createdAt} DESC`)
      .limit(q.limit);

    return {
      entries: rows.map((r) => ({
        id: r.id.toString(),
        entityType: r.entityType,
        provider: r.provider,
        providerUrn: r.providerUrn,
        createdEntityId: r.createdEntityId,
        status: r.status,
        rawPayload: r.rawPayload,
        createdAt: r.createdAt.toISOString(),
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
      })),
    };
  });

  app.post("/admin/mapping/:id/review", async (request) => {
    const admin = request.requireRole("admin");
    const params = z
      .object({ id: z.coerce.bigint() })
      .parse(request.params);
    const body = reviewBody.parse(request.body);

    const [existing] = await app.db
      .select()
      .from(mappingReviewQueue)
      .where(eq(mappingReviewQueue.id, params.id))
      .limit(1);
    if (!existing) throw new NotFoundError("mapping_entry_not_found", "mapping_entry_not_found");
    if (existing.status !== "pending") {
      throw new BadRequestError("already_reviewed", "already_reviewed");
    }

    const newStatus = body.decision === "approve" ? "approved" : "rejected";

    await app.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(mappingReviewQueue)
        .set({
          status: newStatus,
          reviewedBy: admin.id,
          reviewedAt: new Date(),
        })
        .where(eq(mappingReviewQueue.id, params.id))
        .returning();

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: `mapping.${newStatus}`,
        targetType: "mapping_review_queue",
        targetId: params.id.toString(),
        beforeJson: { status: existing.status },
        afterJson: {
          status: newStatus,
          note: body.note ?? null,
          entityType: existing.entityType,
          providerUrn: existing.providerUrn,
        },
        ipInet: request.ip ?? null,
      });

      return updated;
    });

    return { id: params.id.toString(), status: newStatus };
  });

  // ── Lightweight summary for the dashboard KPI cards ───────────────────
  app.get("/admin/mapping/summary", async (request) => {
    request.requireRole("admin");
    const rows = await app.db
      .select({
        status: mappingReviewQueue.status,
        count: sql<string>`COUNT(*)::text`,
      })
      .from(mappingReviewQueue)
      .groupBy(mappingReviewQueue.status);
    const byStatus: Record<string, number> = { pending: 0, approved: 0, rejected: 0 };
    for (const r of rows) byStatus[r.status] = Number(r.count);
    return byStatus;
  });
}
