// /auth/* endpoints. Rate-limit is declared per-route via route `config`
// (fastify-rate-limit reads `config.rateLimit`).

import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthService } from "./service.js";
import {
  setAccessCookie,
  setRefreshCookie,
  clearAuthCookies,
  REFRESH_COOKIE,
} from "../../lib/cookies.js";
import { UnauthorizedError } from "../../lib/errors.js";
import { accountNamespaceFromRequest } from "../../lib/account-namespace.js";

const writeRateLimit = {
  rateLimit: { max: 10, timeWindow: "1 minute" },
};
const loginRateLimit = {
  rateLimit: { max: 5, timeWindow: "1 minute" },
};

// Refresh runs server-to-server from the Next.js middleware on every page
// load that lacks a valid access cookie. The middleware bypasses Caddy and
// hits api:3001 directly, so request.ip resolves to the web container's
// docker IP for every user — a shared bucket. Without a custom key, the
// global write limit (10/min/IP) becomes a global cap of 10 refreshes per
// minute across the entire site, which is what was forcing users to log
// back in repeatedly. Possession of a valid refresh cookie is the real
// gate; key the bucket by a hash of the cookie so each user has their
// own quota. Hashed (not raw) so the rate-limit store doesn't pin
// long-lived tokens in memory.
//
// 60/min is well above legitimate burst load — a normal user refreshes
// at most once per 15 min, and even ~20 concurrent browser tabs on a
// cold-start are an order of magnitude under the cap. We keep IP as
// the fallback so an unauthenticated flood (no cookie) still gets
// throttled.
const refreshRateLimit = {
  rateLimit: {
    max: 60,
    timeWindow: "1 minute",
    keyGenerator: (request: FastifyRequest): string => {
      const cookies = request.cookies as Record<string, string | undefined>;
      const raw = cookies?.[REFRESH_COOKIE];
      if (raw && raw.length > 0) {
        return `refresh:${createHash("sha256").update(raw).digest("hex")}`;
      }
      return request.ip;
    },
  },
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

const verifyEmailBody = z.object({
  // Tokens are 32 random bytes → 43 base64url chars. Allow up to 128
  // to keep the schema permissive for any future widening of the token
  // size without breaking inflight requests.
  token: z.string().min(16).max(128),
});

const forgotPasswordBody = z.object({
  email: z.string().email().max(320),
});

const resetPasswordBody = z.object({
  token: z.string().min(16).max(128),
  newPassword: z.string().min(8).max(256),
});

interface PublicAuthResponse {
  user: {
    id: string;
    email: string;
    role: "user" | "admin" | "support";
    status: "active" | "blocked" | "pending_kyc";
    kycStatus: "none" | "pending" | "approved" | "rejected";
    displayName: string | null;
    nickname: string | null;
    countryCode: string | null;
    sportOrder: string[] | null;
    hiddenSports: string[] | null;
    emailVerifiedAt: string | null;
  };
  accessTokenExpiresAt: string;
}

export default async function authRoutes(app: FastifyInstance) {
  const svc = new AuthService(app.db, app.auth, app.jwtKey, app.redis);

  app.post("/auth/signup", { config: writeRateLimit }, async (request, reply): Promise<PublicAuthResponse> => {
    // Public signup is bettor-namespace only. Admin / support rows are
    // created exclusively through /admin/users with audit logging. A
    // POST to /auth/signup on the admin subdomain would otherwise
    // silently create a bettor row that the admin host can't even
    // authenticate against.
    if (accountNamespaceFromRequest(request) !== "bettor") {
      throw new UnauthorizedError("signup_disabled_here", "signup_disabled_here");
    }
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
    // Bettor login on oddzilla.cc, admin login on sadmin.oddzilla.cc.
    // Same email can back a row in each namespace since migration 0065.
    const namespace = accountNamespaceFromRequest(request);
    const { user, tokens } = await svc.login(body.email, body.password, ctx, namespace);
    setAccessCookie(reply, tokens.accessToken, app.auth);
    setRefreshCookie(reply, tokens.refreshTokenRaw, app.auth);
    return {
      user: publicize(user),
      accessTokenExpiresAt: tokens.accessExpiresAt.toISOString(),
    };
  });

  app.post("/auth/refresh", { config: refreshRateLimit }, async (request, reply): Promise<PublicAuthResponse> => {
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

  // ── Email verification ─────────────────────────────────────────────────
  // Consumed by the verify-email link in the signup confirmation
  // email. No auth required: the token itself is the credential. The
  // route handler returns the updated user so the storefront can
  // hide the unverified-banner immediately on success.
  app.post("/auth/verify-email", { config: writeRateLimit }, async (request) => {
    const body = verifyEmailBody.parse(request.body);
    const user = await svc.consumeEmailVerificationToken(body.token);
    return { user: publicize(user) };
  });

  // Resend the verify-email link. Auth-required so we know which
  // user to email; idempotent against re-verified users (returns
  // success without sending). The dedup_key on the outbox row makes
  // a rapid double-click harmless at the SQL layer too.
  app.post(
    "/auth/resend-verification",
    {
      // Tighter limit than the global writeRateLimit because each
      // call enqueues an email; 3/min/IP is plenty for legitimate
      // "I didn't get it" retries without enabling email-bomb abuse.
      config: { rateLimit: { max: 3, timeWindow: "1 minute" } },
    },
    async (request) => {
      const u = request.requireAuth();
      const { enqueued } = await svc.resendVerificationEmail(u.id);
      return { ok: true, enqueued };
    },
  );

  // ── Password reset ────────────────────────────────────────────────────
  // Always returns 200 to prevent account enumeration. The actual
  // enqueue is namespace-scoped via the request host so a forgot
  // request from the storefront doesn't accidentally trigger a reset
  // for the admin row that shares the same email (post-migration 0065).
  app.post(
    "/auth/forgot-password",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request) => {
      const body = forgotPasswordBody.parse(request.body);
      const namespace = accountNamespaceFromRequest(request);
      await svc.requestPasswordReset(body.email, namespace, request.ip ?? null);
      return { ok: true };
    },
  );

  // Consume a password-reset token. On success: every session for
  // the user is revoked (the user re-authenticates on next visit)
  // and the access JWTs of every device are invalidated through the
  // Redis revoke cache. We don't auto-issue tokens here — forcing a
  // fresh login keeps the reset flow conceptually simple.
  app.post(
    "/auth/reset-password",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = resetPasswordBody.parse(request.body);
      await svc.consumePasswordResetToken(body.token, body.newPassword);
      // Defensive cookie clear in case the user is currently logged
      // in on this device — the next request would otherwise hit a
      // revoked session and 401, which is harmless but ugly. Clearing
      // here forces the storefront to render the logged-out shell
      // immediately.
      clearAuthCookies(reply, app.auth);
      return { ok: true };
    },
  );
}

function publicize(u: {
  id: string;
  email: string;
  role: "user" | "admin" | "support";
  status: "active" | "blocked" | "pending_kyc";
  kycStatus: "none" | "pending" | "approved" | "rejected";
  displayName: string | null;
  nickname: string | null;
  countryCode: string | null;
  sportOrder: string[] | null;
  hiddenSports: string[] | null;
  emailVerifiedAt: Date | null;
}) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    status: u.status,
    kycStatus: u.kycStatus,
    displayName: u.displayName,
    nickname: u.nickname,
    countryCode: u.countryCode,
    sportOrder: u.sportOrder,
    hiddenSports: u.hiddenSports,
    emailVerifiedAt: u.emailVerifiedAt ? u.emailVerifiedAt.toISOString() : null,
  };
}
