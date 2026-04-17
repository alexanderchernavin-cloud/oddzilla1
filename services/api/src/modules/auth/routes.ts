// /auth/* endpoints. Rate-limit is declared per-route via route `config`
// (fastify-rate-limit reads `config.rateLimit`).

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthService } from "./service.js";
import {
  setAccessCookie,
  setRefreshCookie,
  clearAuthCookies,
  REFRESH_COOKIE,
} from "../../lib/cookies.js";
import { UnauthorizedError } from "../../lib/errors.js";

const writeRateLimit = {
  rateLimit: { max: 10, timeWindow: "1 minute" },
};
const loginRateLimit = {
  rateLimit: { max: 5, timeWindow: "1 minute" },
};

const signupBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(256),
  displayName: z.string().min(1).max(64).optional(),
  countryCode: z
    .string()
    .length(2)
    .regex(/^[A-Za-z]{2}$/)
    .transform((s) => s.toUpperCase())
    .optional(),
  deviceId: z.string().max(64).optional(),
});

const loginBody = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
  deviceId: z.string().max(64).optional(),
});

interface PublicAuthResponse {
  user: {
    id: string;
    email: string;
    role: "user" | "admin" | "support";
    status: "active" | "blocked" | "pending_kyc";
    kycStatus: "none" | "pending" | "approved" | "rejected";
    displayName: string | null;
    countryCode: string | null;
  };
  accessTokenExpiresAt: string;
}

export default async function authRoutes(app: FastifyInstance) {
  const svc = new AuthService(app.db, app.auth, app.jwtKey);

  app.post("/auth/signup", { config: writeRateLimit }, async (request, reply): Promise<PublicAuthResponse> => {
    const body = signupBody.parse(request.body);
    const ctx = {
      ip: request.ip ?? null,
      userAgent: request.headers["user-agent"] ?? null,
      deviceId: body.deviceId ?? null,
    };
    const { user, tokens } = await svc.signup({
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      countryCode: body.countryCode,
      ...ctx,
    });
    setAccessCookie(reply, tokens.accessToken, app.auth);
    setRefreshCookie(reply, tokens.refreshTokenRaw, app.auth);
    return {
      user: publicize(user),
      accessTokenExpiresAt: tokens.accessExpiresAt.toISOString(),
    };
  });

  app.post("/auth/login", { config: loginRateLimit }, async (request, reply): Promise<PublicAuthResponse> => {
    const body = loginBody.parse(request.body);
    const ctx = {
      ip: request.ip ?? null,
      userAgent: request.headers["user-agent"] ?? null,
      deviceId: body.deviceId ?? null,
    };
    const { user, tokens } = await svc.login(body.email, body.password, ctx);
    setAccessCookie(reply, tokens.accessToken, app.auth);
    setRefreshCookie(reply, tokens.refreshTokenRaw, app.auth);
    return {
      user: publicize(user),
      accessTokenExpiresAt: tokens.accessExpiresAt.toISOString(),
    };
  });

  app.post("/auth/refresh", { config: writeRateLimit }, async (request, reply): Promise<PublicAuthResponse> => {
    const cookies = request.cookies as Record<string, string | undefined>;
    const raw = cookies?.[REFRESH_COOKIE];
    if (!raw) throw new UnauthorizedError("no_refresh_cookie", "no_refresh_cookie");

    const ctx = {
      ip: request.ip ?? null,
      userAgent: request.headers["user-agent"] ?? null,
      deviceId: null,
    };
    const tokens = await svc.refresh(raw, ctx);
    const user = await svc.me(tokens.userId);
    if (!user) throw new UnauthorizedError();

    setAccessCookie(reply, tokens.accessToken, app.auth);
    setRefreshCookie(reply, tokens.refreshTokenRaw, app.auth);
    return {
      user: publicize(user),
      accessTokenExpiresAt: tokens.accessExpiresAt.toISOString(),
    };
  });

  app.post("/auth/logout", async (request, reply) => {
    const u = request.user;
    if (u?.sessionId) {
      await svc.logout(u.sessionId);
    }
    clearAuthCookies(reply, app.auth);
    return { ok: true };
  });

  app.get("/auth/me", async (request) => {
    const u = request.requireAuth();
    const user = await svc.me(u.id);
    if (!user) throw new UnauthorizedError();
    return { user: publicize(user) };
  });
}

function publicize(u: {
  id: string;
  email: string;
  role: "user" | "admin" | "support";
  status: "active" | "blocked" | "pending_kyc";
  kycStatus: "none" | "pending" | "approved" | "rejected";
  displayName: string | null;
  countryCode: string | null;
}) {
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
