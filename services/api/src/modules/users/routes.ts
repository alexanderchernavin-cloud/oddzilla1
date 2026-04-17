// /users/me endpoints. Profile edit + password change.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import { users, sessions } from "@oddzilla/db";
import { hashPassword, verifyPassword } from "@oddzilla/auth";
import {
  UnauthorizedError,
  NotFoundError,
  BadRequestError,
} from "../../lib/errors.js";
import { clearAuthCookies } from "../../lib/cookies.js";

const updateBody = z.object({
  displayName: z.string().min(1).max(64).nullable().optional(),
  countryCode: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/)
    .transform((s) => s.toUpperCase())
    .nullable()
    .optional(),
});

const passwordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
});

export default async function usersRoutes(app: FastifyInstance) {
  app.get("/users/me", async (request) => {
    const u = request.requireAuth();
    const [user] = await app.db.select().from(users).where(eq(users.id, u.id)).limit(1);
    if (!user) throw new NotFoundError();
    return { user: publicize(user) };
  });

  app.patch("/users/me", async (request) => {
    const u = request.requireAuth();
    const body = updateBody.parse(request.body);

    if (body.displayName === undefined && body.countryCode === undefined) {
      throw new BadRequestError("no_changes", "no_changes");
    }

    const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.countryCode !== undefined) patch.countryCode = body.countryCode;

    const [updated] = await app.db
      .update(users)
      .set(patch)
      .where(eq(users.id, u.id))
      .returning();
    if (!updated) throw new NotFoundError();
    return { user: publicize(updated) };
  });

  app.post("/users/me/password", async (request, reply) => {
    const u = request.requireAuth();
    const body = passwordBody.parse(request.body);

    const [user] = await app.db.select().from(users).where(eq(users.id, u.id)).limit(1);
    if (!user) throw new NotFoundError();

    const ok = await verifyPassword(user.passwordHash, body.currentPassword);
    if (!ok) throw new UnauthorizedError("invalid_current_password", "invalid_current_password");

    const newHash = await hashPassword(body.newPassword);

    await app.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash: newHash, updatedAt: new Date() })
        .where(eq(users.id, u.id));
      // Force re-login on every device for safety.
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, u.id), isNull(sessions.revokedAt)));
    });

    clearAuthCookies(reply, app.auth);
    return { ok: true };
  });
}

function publicize(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    status: u.status,
    kycStatus: u.kycStatus,
    displayName: u.displayName,
    countryCode: u.countryCode,
  };
}
