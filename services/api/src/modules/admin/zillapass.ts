// /admin/zillapass — task catalog CRUD. Admin-only; every mutation
// writes an admin_audit_log row. The user-facing /zillapass/me reads
// the same table.
//
// Predicate vocabulary is intentionally open-ended (TEXT column) so
// the product team can add new task kinds without a migration. The
// downstream writer (once wired) will simply skip rows whose
// `predicate_key` it doesn't recognise.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, asc } from "drizzle-orm";
import {
  zillapassTasks,
  adminAuditLog,
  type ZillapassTask,
} from "@oddzilla/db";
import type { ZillapassTaskDto } from "@oddzilla/types";
import { NotFoundError } from "../../lib/errors.js";

const periodSchema = z.enum(["daily", "weekly", "season"]);

// Slug shape mirrors community / sport slug conventions: lower-kebab
// with digits, 2–60 chars. Stable identifier; admin can rename the
// title freely but the slug stays put.
const slugSchema = z
  .string()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug_invalid");

const createBody = z.object({
  slug: slugSchema,
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional().nullable(),
  targetCount: z.number().int().min(1).max(1_000_000),
  predicateKey: z.string().min(1).max(80),
  period: periodSchema.default("daily"),
  // Stage the task belongs to. Users only see tasks where setNumber
  // matches their current_set_number. Defaults to 1 (day-1 stage).
  setNumber: z.number().int().min(1).max(10_000).default(1),
  rewardKind: z.string().max(40).optional().nullable(),
  rewardPayload: z.unknown().optional().nullable(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});

const patchBody = createBody.partial().extend({
  // slug cannot change post-create — drop it from the patch shape so
  // an accidental request body field doesn't silently no-op or worse
  // succeed on a different unique index.
  slug: z.undefined().optional(),
});

function toDto(row: ZillapassTask): ZillapassTaskDto {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    targetCount: row.targetCount,
    predicateKey: row.predicateKey,
    period: row.period,
    setNumber: row.setNumber,
    rewardKind: row.rewardKind,
    rewardPayload: row.rewardPayload,
    active: row.active,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export default async function adminZillapassRoutes(app: FastifyInstance) {
  app.get("/admin/zillapass/tasks", async (request) => {
    request.requireRole("admin");
    const rows = await app.db
      .select()
      .from(zillapassTasks)
      .orderBy(asc(zillapassTasks.sortOrder), asc(zillapassTasks.id));
    return { tasks: rows.map(toDto) };
  });

  app.post("/admin/zillapass/tasks", async (request) => {
    const admin = request.requireRole("admin");
    const body = createBody.parse(request.body);

    const result = await app.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(zillapassTasks)
        .values({
          slug: body.slug,
          title: body.title,
          description: body.description ?? null,
          targetCount: body.targetCount,
          predicateKey: body.predicateKey,
          period: body.period,
          setNumber: body.setNumber,
          rewardKind: body.rewardKind ?? null,
          rewardPayload: body.rewardPayload ?? null,
          active: body.active,
          sortOrder: body.sortOrder,
          createdBy: admin.id,
        })
        .returning();
      if (!created) throw new Error("zillapass_tasks insert returned no row");

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "zillapass.task.create",
        targetType: "zillapass_task",
        targetId: created.id.toString(),
        beforeJson: null,
        afterJson: toDto(created),
        ipInet: request.ip ?? null,
      });

      return created;
    });

    return { task: toDto(result) };
  });

  app.patch("/admin/zillapass/tasks/:id", async (request) => {
    const admin = request.requireRole("admin");
    const params = z.object({ id: z.coerce.number().int() }).parse(request.params);
    const body = patchBody.parse(request.body);

    const [before] = await app.db
      .select()
      .from(zillapassTasks)
      .where(eq(zillapassTasks.id, params.id))
      .limit(1);
    if (!before) {
      throw new NotFoundError("zillapass_task_not_found", "zillapass_task_not_found");
    }

    // Drizzle: skip undefined-valued keys so an empty PATCH body
    // doesn't null out columns the caller didn't touch.
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (body.title !== undefined) update.title = body.title;
    if (body.description !== undefined) update.description = body.description;
    if (body.targetCount !== undefined) update.targetCount = body.targetCount;
    if (body.predicateKey !== undefined) update.predicateKey = body.predicateKey;
    if (body.period !== undefined) update.period = body.period;
    if (body.setNumber !== undefined) update.setNumber = body.setNumber;
    if (body.rewardKind !== undefined) update.rewardKind = body.rewardKind;
    if (body.rewardPayload !== undefined) update.rewardPayload = body.rewardPayload;
    if (body.active !== undefined) update.active = body.active;
    if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;

    const result = await app.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(zillapassTasks)
        .set(update)
        .where(eq(zillapassTasks.id, params.id))
        .returning();
      if (!updated) throw new Error("zillapass_tasks update returned no row");

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "zillapass.task.update",
        targetType: "zillapass_task",
        targetId: updated.id.toString(),
        beforeJson: toDto(before),
        afterJson: toDto(updated),
        ipInet: request.ip ?? null,
      });

      return updated;
    });

    return { task: toDto(result) };
  });

  app.delete("/admin/zillapass/tasks/:id", async (request, reply) => {
    const admin = request.requireRole("admin");
    const params = z.object({ id: z.coerce.number().int() }).parse(request.params);

    const [before] = await app.db
      .select()
      .from(zillapassTasks)
      .where(eq(zillapassTasks.id, params.id))
      .limit(1);
    if (!before) {
      throw new NotFoundError("zillapass_task_not_found", "zillapass_task_not_found");
    }

    await app.db.transaction(async (tx) => {
      await tx.delete(zillapassTasks).where(eq(zillapassTasks.id, params.id));
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "zillapass.task.delete",
        targetType: "zillapass_task",
        targetId: before.id.toString(),
        beforeJson: toDto(before),
        afterJson: null,
        ipInet: request.ip ?? null,
      });
    });

    reply.code(204);
    return null;
  });
}
