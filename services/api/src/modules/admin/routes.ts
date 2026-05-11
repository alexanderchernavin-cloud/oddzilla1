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
  entityType: z
    .enum(["sport", "category", "tournament", "match", "competitor", "market_type"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const reviewBody = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(500).optional(),
});

const bulkReviewBody = z.object({
  // Approve-all is the common case (the ingester auto-creates good
  // mappings most of the time; the queue is a safety net). Reject-all
  // is intentionally not exposed — operators should never wipe the
  // queue without inspection. Per-row reject stays for those cases.
  decision: z.literal("approve"),
  entityType: z
    .enum(["sport", "category", "tournament", "match", "competitor", "market_type"])
    .optional(),
  // Optional cap so a runaway invocation can't lock the row set for
  // minutes. Defaults to "no cap" because the realistic queue size
  // is bounded by Oddin's catalog size.
  limit: z.coerce.number().int().min(1).max(100_000).optional(),
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

  // Bulk-approve every pending row (optionally scoped to one
  // entity_type). Single SQL UPDATE plus a single audit_log row
  // summarising the action — writing 20k+ per-row audit entries
  // would crawl under the hash-chain trigger's advisory lock.
  app.post("/admin/mapping/bulk-review", async (request) => {
    const admin = request.requireRole("admin");
    const body = bulkReviewBody.parse(request.body);
    const newStatus = "approved";

    const reviewedAt = new Date();
    const result = await app.db.transaction(async (tx) => {
      // Cap the row set via a CTE when a limit is requested; without
      // one we update every pending row in one shot. The matching
      // predicate stays identical to the GET filter so the operator
      // gets exactly what they were looking at.
      const updated = body.limit
        ? ((await tx.execute(sql`
            WITH target AS (
              SELECT id FROM mapping_review_queue
               WHERE status = 'pending'
                 ${body.entityType ? sql`AND entity_type = ${body.entityType}` : sql``}
               ORDER BY created_at ASC
               LIMIT ${body.limit}
            )
            UPDATE mapping_review_queue m
               SET status      = 'approved',
                   reviewed_by = ${admin.id}::uuid,
                   reviewed_at = ${reviewedAt.toISOString()}::timestamptz
              FROM target
             WHERE m.id = target.id
             RETURNING m.id
          `)) as unknown as Array<{ id: string }>)
        : ((await tx.execute(sql`
            UPDATE mapping_review_queue
               SET status      = 'approved',
                   reviewed_by = ${admin.id}::uuid,
                   reviewed_at = ${reviewedAt.toISOString()}::timestamptz
             WHERE status = 'pending'
               ${body.entityType ? sql`AND entity_type = ${body.entityType}` : sql``}
             RETURNING id
          `)) as unknown as Array<{ id: string }>);

      const count = updated.length;

      // Audit log: one summary row, not N per-row rows. Includes the
      // exact filter applied and the count so the action is replayable
      // from the log alone.
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: `mapping.bulk_${newStatus}`,
        targetType: "mapping_review_queue",
        targetId: body.entityType ?? "*",
        beforeJson: { status: "pending", entityType: body.entityType ?? null },
        afterJson: {
          status: newStatus,
          entityType: body.entityType ?? null,
          count,
          limit: body.limit ?? null,
        },
        ipInet: request.ip ?? null,
      });

      return count;
    });

    return { decision: newStatus, count: result };
  });

  // ── Lightweight summary for the dashboard KPI cards ───────────────────
  // Optional `?entityType=…` returns counts scoped to a single type so
  // the bulk-approve button can render the exact filtered total
  // (the page-level list is capped at 100, so .length isn't enough).
  app.get("/admin/mapping/summary", async (request) => {
    request.requireRole("admin");
    const q = z
      .object({
        entityType: z
          .enum([
            "sport",
            "category",
            "tournament",
            "match",
            "competitor",
            "market_type",
          ])
          .optional(),
      })
      .parse(request.query);
    const rows = q.entityType
      ? await app.db
          .select({
            status: mappingReviewQueue.status,
            count: sql<string>`COUNT(*)::text`,
          })
          .from(mappingReviewQueue)
          .where(eq(mappingReviewQueue.entityType, q.entityType))
          .groupBy(mappingReviewQueue.status)
      : await app.db
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
