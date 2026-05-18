// Cookie helpers shared between /auth routes. SameSite=Lax keeps cookies
// out of unsafe cross-site sub-requests while still flowing them on top-
// level GET navigation (so a link to oddzilla.cc from email/Google does
// not appear logged out). Both cookies use Path=/ because Caddy rewrites
// the browser-visible path (/api/auth/...) before reaching the API; a
// narrower Path=/auth scope would never match the browser request and
// the refresh cookie would silently never be sent.
//
// Cookies are HOST-SCOPED (no Domain attribute). This means a session on
// oddzilla.cc and a session on sadmin.oddzilla.cc are independent: an
// operator can be logged in as a bettor on the apex and as an admin on
// the backoffice in the same browser without overwriting either. Prior
// to 2026-05-18 the cookie carried Domain=.oddzilla.cc and was shared
// across both subdomains — see CLAUDE.md for the rationale change.

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
    maxAge: auth.jwtAccessTtlSeconds,
  });
  expireLegacySharedDomainCookie(reply, ACCESS_COOKIE, auth);
}

export function setRefreshCookie(reply: FastifyReply, token: string, auth: AuthEnv) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: auth.isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: auth.refreshTtlDays * 24 * 60 * 60,
  });
  expireLegacySharedDomainCookie(reply, REFRESH_COOKIE, auth);
}

export function clearAuthCookies(reply: FastifyReply, auth: AuthEnv) {
  reply.clearCookie(ACCESS_COOKIE, { path: "/" });
  reply.clearCookie(REFRESH_COOKIE, { path: "/" });
  // Also clear any leftover refresh cookie scoped to the old `/auth` path
  // so users with stale browser state don't end up with a phantom cookie
  // that will never be sent and never get cleaned up.
  reply.clearCookie(REFRESH_COOKIE, { path: "/auth" });
  expireLegacySharedDomainCookie(reply, ACCESS_COOKIE, auth);
  expireLegacySharedDomainCookie(reply, REFRESH_COOKIE, auth);
}

// Migration helper. Before the 2026-05-18 cutover the auth cookies were
// set with Domain=COOKIE_DOMAIN (`.oddzilla.cc` in prod) so a single
// session covered both subdomains. The new model is host-scoped — so
// after deploy a browser may briefly hold BOTH the legacy shared-domain
// cookie AND the new host-scoped cookie under the same name. Cookies are
// keyed by (name, domain, path) in the browser jar, so they coexist
// instead of overwriting, and the server sees ambiguous "two values for
// one name" in the Cookie header.
//
// Emitting a Max-Age=0 Set-Cookie with the legacy Domain attribute on
// every set/clear evicts the old cookie cleanly on the next response.
// Safe no-op locally (cookieDomain is undefined → nothing emitted) and
// safe to remove ~30 days post-deploy once every long-lived refresh
// cookie has rotated through this path.
function expireLegacySharedDomainCookie(
  reply: FastifyReply,
  name: typeof ACCESS_COOKIE | typeof REFRESH_COOKIE,
  auth: AuthEnv,
) {
  if (!auth.cookieDomain) return;
  reply.clearCookie(name, { path: "/", domain: auth.cookieDomain });
  if (name === REFRESH_COOKIE) {
    // The pre-migration refresh cookie may also exist under Path=/auth.
    reply.clearCookie(name, { path: "/auth", domain: auth.cookieDomain });
  }
}
