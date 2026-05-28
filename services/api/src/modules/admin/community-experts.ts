// /admin/community/experts — manual Expert nomination.
//
// V1 mode is admin-driven. A future PR introduces the spec's monthly
// auto-recalc (top-5 per sport, max 2 sports per analyst). Until
// then, ops manages the table by hand via this endpoint. The
// `nominated_by` FK on community_experts records who promoted whom
// for auditability.
//
// The "max 2 sports per analyst" cap from the spec is enforced as a
// pre-insert SELECT here. It's a soft constraint at v1 — the recalc
// cron will replace this with a proper invariant when it lands.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, gt, sql } from "drizzle-orm";
import { adminAuditLog, communityExperts, sports, users } from "@oddzilla/db";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";

const MAX_EXPERT_SPORTS_PER_USER = 2; // Reward formula V1 spec.

const nominateBody = z.object({
  userId: z.string().uuid(),
  // Caller can pass either sportId (numeric) or sportSlug — slug is
  // friendlier for admin UI, id for scripted use. Exactly one
  // required; both is fine (id wins).
  sportId: z.number().int().positive().optional(),
  sportSlug: z.string().min(2).max(60).optional(),
  // How long this Expert status lasts. Default 30 days matches the
  // spec's monthly recalc cadence; admin can extend for sponsorship
  // windows or shorten for time-bounded tests.
  validDays: z.number().int().min(1).max(365).default(30),
});

const revokeParams = z.object({
  userId: z.string().uuid(),
  sportId: z.coerce.number().int().positive(),
});

export default async function adminCommunityExpertsRoutes(app: FastifyInstance) {
  // ─── POST /admin/community/experts ───────────────────────────────────────
  app.post("/admin/community/experts", async (request) => {
    const admin = request.requireRole("admin");
    const body = nominateBody.parse(request.body);

    if (body.sportId === undefined && body.sportSlug === undefined) {
      throw new BadRequestError(
        "sport_required",
        "Either sportId or sportSlug is required",
      );
    }

    // Resolve sportId from slug if needed.
    let sportId = body.sportId;
    if (sportId === undefined && body.sportSlug !== undefined) {
      const [s] = await app.db
        .select({ id: sports.id })
        .from(sports)
        .where(eq(sports.slug, body.sportSlug))
        .limit(1);
      if (!s) throw new NotFoundError();
      sportId = s.id;
    }

    // Confirm the user exists (FK would catch it, but a 404 is more
    // informative than a 23503).
    const [user] = await app.db
      .select({ id: users.id, nickname: users.nickname })
      .from(users)
      .where(eq(users.id, body.userId))
      .limit(1);
    if (!user) throw new NotFoundError();

    // Spec cap: at most 2 active Expert sports per user. Count
    // existing active rows (excluding the sport we're about to
    // insert/update — UPSERT semantics mean a re-nomination of an
    // existing pair is just an extension, not a new "sport slot").
    const activeRows = await app.db
      .select({ sportId: communityExperts.sportId })
      .from(communityExperts)
      .where(
        and(
          eq(communityExperts.userId, body.userId),
          gt(communityExperts.validUntil, new Date()),
        ),
      );
    const alreadyExpertInThisSport = activeRows.some(
      (r) => r.sportId === sportId,
    );
    if (!alreadyExpertInThisSport && activeRows.length >= MAX_EXPERT_SPORTS_PER_USER) {
      throw new BadRequestError(
        "expert_sports_cap_reached",
        `User already has ${MAX_EXPERT_SPORTS_PER_USER} active Expert sports`,
      );
    }

    const validUntil = new Date(Date.now() + body.validDays * 24 * 60 * 60 * 1000);

    const inserted = await app.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(communityExperts)
        .values({
          userId: body.userId,
          sportId: sportId!,
          validUntil,
          nominatedBy: admin.id,
        })
        // Re-nomination is a refresh — bump validUntil and re-stamp
        // nominated_by/nominated_at so the audit trail reflects the
        // most-recent decision.
        .onConflictDoUpdate({
          target: [communityExperts.userId, communityExperts.sportId],
          set: {
            validUntil,
            nominatedBy: admin.id,
            nominatedAt: sql`now()`,
          },
        })
        .returning();

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "community.expert.nominate",
        targetType: "community_expert",
        targetId: `${body.userId}:${sportId}`,
        beforeJson: null,
        afterJson: {
          userId: body.userId,
          nickname: user.nickname,
          sportId,
          validUntil: validUntil.toISOString(),
          validDays: body.validDays,
        },
        ipInet: request.ip ?? null,
      });

      return row;
    });

    return {
      userId: inserted!.userId,
      sportId: inserted!.sportId,
      validUntil: inserted!.validUntil.toISOString(),
      nominatedAt: inserted!.nominatedAt.toISOString(),
    };
  });

  // ─── DELETE /admin/community/experts/:userId/:sportId ────────────────────
  app.delete<{ Params: { userId: string; sportId: string } }>(
    "/admin/community/experts/:userId/:sportId",
    async (request, reply) => {
      const admin = request.requireRole("admin");
      const { userId, sportId } = revokeParams.parse(request.params);

      const deleted = await app.db.transaction(async (tx) => {
        const rows = await tx
          .delete(communityExperts)
          .where(
            and(
              eq(communityExperts.userId, userId),
              eq(communityExperts.sportId, sportId),
            ),
          )
          .returning();
        if (rows.length === 0) return null;

        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "community.expert.revoke",
          targetType: "community_expert",
          targetId: `${userId}:${sportId}`,
          beforeJson: rows[0]!,
          afterJson: null,
          ipInet: request.ip ?? null,
        });
        return rows[0];
      });

      if (!deleted) throw new NotFoundError();
      reply.code(204);
    },
  );
}
