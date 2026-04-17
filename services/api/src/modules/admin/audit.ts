// /admin/audit — read-only audit log viewer. Every admin mutation across
// the API writes to admin_audit_log; this endpoint paginates that table
// with light filtering for operational review.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import { adminAuditLog, users } from "@oddzilla/db";

const listQuery = z.object({
  actorId: z.string().uuid().optional(),
  targetType: z.string().max(64).optional(),
  targetId: z.string().max(128).optional(),
  action: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export default async function adminAuditRoutes(app: FastifyInstance) {
  app.get("/admin/audit", async (request) => {
    request.requireRole("admin");
    const q = listQuery.parse(request.query);

    const filters: SQL[] = [];
    if (q.actorId) filters.push(eq(adminAuditLog.actorUserId, q.actorId));
    if (q.targetType) filters.push(eq(adminAuditLog.targetType, q.targetType));
    if (q.targetId) filters.push(eq(adminAuditLog.targetId, q.targetId));
    if (q.action) filters.push(ilike(adminAuditLog.action, `${q.action}%`));
    const whereClause = filters.length > 0 ? and(...filters) : sql`TRUE`;

    const rows = await app.db
      .select({
        id: adminAuditLog.id,
        actorUserId: adminAuditLog.actorUserId,
        actorEmail: users.email,
        action: adminAuditLog.action,
        targetType: adminAuditLog.targetType,
        targetId: adminAuditLog.targetId,
        beforeJson: adminAuditLog.beforeJson,
        afterJson: adminAuditLog.afterJson,
        ipInet: adminAuditLog.ipInet,
        createdAt: adminAuditLog.createdAt,
      })
      .from(adminAuditLog)
      .leftJoin(users, eq(users.id, adminAuditLog.actorUserId))
      .where(whereClause)
      .orderBy(desc(adminAuditLog.createdAt))
      .limit(q.limit)
      .offset(q.offset);

    return {
      entries: rows.map((r) => ({
        id: r.id.toString(),
        actorUserId: r.actorUserId,
        actorEmail: r.actorEmail ?? null,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        beforeJson: r.beforeJson ?? null,
        afterJson: r.afterJson ?? null,
        ipInet: r.ipInet,
        createdAt: r.createdAt.toISOString(),
      })),
      limit: q.limit,
      offset: q.offset,
    };
  });
}
