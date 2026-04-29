// Cookie helpers shared between /auth routes. SameSite=Lax keeps cookies
// out of unsafe cross-site sub-requests while still flowing them on top-
// level GET navigation (so a link to s.oddzilla.cc from email/Google does
// not appear logged out). Both cookies use Path=/ because Caddy rewrites
// the browser-visible path (/api/auth/...) before reaching the API; a
// narrower Path=/auth scope would never match the browser request and
// the refresh cookie would silently never be sent.

import type { FastifyReply } from "fastify";
import type { AuthEnv } from "@oddzilla/config";

export const ACCESS_COOKIE = "oddzilla_access";
export const REFRESH_COOKIE = "oddzilla_refresh";

export function setAccessCookie(reply: FastifyReply, token: string, auth: AuthEnv) {
  reply.setCookie(ACCESS_COOKIE, token, {
    httpOnly: true,
    secure: auth.isProduction,
    sameSite: "lax",
    path: "/",
    domain: auth.cookieDomain,
    maxAge: auth.jwtAccessTtlSeconds,
  });
}

export function setRefreshCookie(reply: FastifyReply, token: string, auth: AuthEnv) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: auth.isProduction,
    sameSite: "lax",
    path: "/",
    domain: auth.cookieDomain,
    maxAge: auth.refreshTtlDays * 24 * 60 * 60,
  });
}

export function clearAuthCookies(reply: FastifyReply, auth: AuthEnv) {
  reply.clearCookie(ACCESS_COOKIE, {
    path: "/",
    domain: auth.cookieDomain,
  });
  reply.clearCookie(REFRESH_COOKIE, {
    path: "/",
    domain: auth.cookieDomain,
  });
  // Also clear any leftover refresh cookie scoped to the old `/auth` path
  // so users with stale browser state don't end up with a phantom cookie
  // that will never be sent and never get cleaned up.
  reply.clearCookie(REFRESH_COOKIE, {
    path: "/auth",
    domain: auth.cookieDomain,
  });
}
