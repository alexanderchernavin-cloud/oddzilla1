// Cookie helpers shared between /auth routes. Same-site Strict on both
// tokens prevents cross-origin leaks. Refresh cookie is scoped to the
// refresh endpoint so it isn't sent on every API call.

import type { FastifyReply } from "fastify";
import type { AuthEnv } from "@oddzilla/config";

export const ACCESS_COOKIE = "oddzilla_access";
export const REFRESH_COOKIE = "oddzilla_refresh";

export function setAccessCookie(reply: FastifyReply, token: string, auth: AuthEnv) {
  reply.setCookie(ACCESS_COOKIE, token, {
    httpOnly: true,
    secure: auth.isProduction,
    sameSite: "strict",
    path: "/",
    domain: auth.cookieDomain,
    maxAge: auth.jwtAccessTtlSeconds,
  });
}

export function setRefreshCookie(reply: FastifyReply, token: string, auth: AuthEnv) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: auth.isProduction,
    sameSite: "strict",
    path: "/auth",
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
    path: "/auth",
    domain: auth.cookieDomain,
  });
}
