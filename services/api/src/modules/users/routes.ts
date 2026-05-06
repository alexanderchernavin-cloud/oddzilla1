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
import { SESSION_STATUS_KEY } from "../../plugins/auth.js";

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

// Tight per-user rate limit on the password endpoint. verifyPassword is
// intentionally ~50ms per call; without a limit a stolen-cookie attacker
// can brute-force `currentPassword` while also turning the endpoint into
// a CPU-DoS surface.
const passwordChangeRateLimit = {
  rateLimit: { max: 5, timeWindow: "5 minutes" },
};

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

  app.post(
    "/users/me/password",
    { config: passwordChangeRateLimit },
    async (request, reply) => {
      const u = request.requireAuth();
      const body = passwordBody.parse(request.body);

      const [user] = await app.db.select().from(users).where(eq(users.id, u.id)).limit(1);
      if (!user) throw new NotFoundError();

      const ok = await verifyPassword(user.passwordHash, body.currentPassword);
      if (!ok) throw new UnauthorizedError("invalid_current_password", "invalid_current_password");

      const newHash = await hashPassword(body.newPassword);

      // Force re-login on every device. The cache flip on each session
      // id (below) is what makes the existing 15-min access JWTs stop
      // working immediately on those other devices — without it they'd
      // remain authenticated until their access token expired, leaving
      // a window for a stolen-cookie attacker to keep operating after
      // the legitimate user reset their password.
      const revoked = await app.db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({ passwordHash: newHash, updatedAt: new Date() })
          .where(eq(users.id, u.id));
        return tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(sessions.userId, u.id), isNull(sessions.revokedAt)))
          .returning({ id: sessions.id });
      });
      const ttl = Math.max(60, app.auth.jwtAccessTtlSeconds + 60);
      await Promise.all(
        revoked.map((s) =>
          app.redis.set(SESSION_STATUS_KEY(s.id), "revoked", "EX", ttl).catch(() => undefined),
        ),
      );

      clearAuthCookies(reply, app.auth);
      return { ok: true };
    },
  );
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
