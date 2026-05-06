// Reads the access cookie on every request and populates `request.user` if
// the JWT verifies. Does NOT reject requests — individual routes opt-in by
// calling `request.requireAuth()` or `request.requireRole('admin')`.
// This keeps public routes (signup, login) friction-free.

import fp from "fastify-plugin";
import { eq } from "drizzle-orm";
import { sessions } from "@oddzilla/db";
import { verifyAccessToken, secretKey, type AccessTokenClaims } from "@oddzilla/auth";
import type { AuthEnv } from "@oddzilla/config";
import { ACCESS_COOKIE } from "../lib/cookies.js";
import { ForbiddenError, UnauthorizedError } from "../lib/errors.js";

export interface AuthedUser {
  id: string;
  role: "user" | "admin" | "support";
  sessionId?: string;
}

declare module "fastify" {
  interface FastifyInstance {
    auth: AuthEnv;
    jwtKey: Uint8Array;
  }
  interface FastifyRequest {
    user?: AuthedUser;
    requireAuth(): AuthedUser;
    requireRole(role: "admin" | "support"): AuthedUser;
  }
}

// Per-session revocation cache key. Exported so AuthService.revoke paths
// can flip it to "revoked" the moment a session is logged out / replaced
// without waiting for the cache to fall out of TTL.
export const SESSION_STATUS_KEY = (sid: string) => `session:status:${sid}`;
const SESSION_STATUS_TTL_SECONDS = 60;

export default fp<{ auth: AuthEnv }>(async (app, opts) => {
  const key = secretKey(opts.auth.jwtSecret);
  app.decorate("auth", opts.auth);
  app.decorate("jwtKey", key);

  // decorateRequest requires a factory for non-primitive initial values.
  // `user` is set by the preHandler below; undefined here.
  app.decorateRequest("user", undefined);
  app.decorateRequest("requireAuth", function (this: import("fastify").FastifyRequest) {
    if (!this.user) throw new UnauthorizedError();
    return this.user;
  });
  app.decorateRequest("requireRole", function (
    this: import("fastify").FastifyRequest,
    role: "admin" | "support",
  ) {
    const u = this.user;
    if (!u) throw new UnauthorizedError();
    // admin implicitly includes support permissions
    if (role === "support" && (u.role === "support" || u.role === "admin")) return u;
    if (role === "admin" && u.role === "admin") return u;
    throw new ForbiddenError();
  });

  app.addHook("preHandler", async (request) => {
    const cookies = request.cookies as Record<string, string | undefined>;
    const token = cookies?.[ACCESS_COOKIE];
    if (!token) return;
    let claims: AccessTokenClaims;
    try {
      claims = await verifyAccessToken(token, key);
    } catch {
      // Invalid/expired token: leave request.user unset. The client should
      // call /auth/refresh to rotate.
      return;
    }

    // Revocation check. Without this, an access JWT remains valid for its
    // full 15 minutes after logout / password change / refresh-replay —
    // the JWT itself has no link back to revocation. Redis cache keeps
    // the per-request DB hit out of the hot path; on cache miss we fall
    // through to the sessions table.
    const sid = claims.sid;
    if (sid) {
      let status = await app.redis.get(SESSION_STATUS_KEY(sid));
      if (status === null) {
        const [row] = await app.db
          .select({ revokedAt: sessions.revokedAt })
          .from(sessions)
          .where(eq(sessions.id, sid))
          .limit(1);
        status = row && row.revokedAt === null ? "active" : "revoked";
        await app.redis.set(SESSION_STATUS_KEY(sid), status, "EX", SESSION_STATUS_TTL_SECONDS);
      }
      if (status !== "active") {
        // Drop the request.user assignment so requireAuth() / requireRole()
        // reject. Don't throw here — public routes still work.
        return;
      }
    }

    request.user = {
      id: claims.sub,
      role: claims.role,
      sessionId: claims.sid,
    };
  });
});
