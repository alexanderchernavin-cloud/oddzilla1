// Reads the access cookie on every request and populates `request.user` if
// the JWT verifies. Does NOT reject requests — individual routes opt-in by
// calling `request.requireAuth()` or `request.requireRole('admin')`.
// This keeps public routes (signup, login) friction-free.

import fp from "fastify-plugin";
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
    try {
      const claims: AccessTokenClaims = await verifyAccessToken(token, key);
      request.user = {
        id: claims.sub,
        role: claims.role,
        sessionId: claims.sid,
      };
    } catch {
      // Invalid/expired token: leave request.user unset. The client should
      // call /auth/refresh to rotate.
    }
  });
});
