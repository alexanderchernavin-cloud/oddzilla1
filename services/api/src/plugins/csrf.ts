// Origin / Referer-based CSRF defense.
//
// Why server-side and not just CORS? CORS prevents cross-origin pages
// from *reading* responses, but a forged form / fetch in
// application/x-www-form-urlencoded or text/plain mode reaches the server
// and triggers any side effect *before* CORS rejects the response.
// Cookies are still attached because SameSite=Lax allows them on
// top-level navigations and same-site POSTs. With a Domain=.oddzilla.cc
// cookie this means any present-or-future *.oddzilla.cc subdomain (or
// dangling DNS) can issue authenticated state-changing calls.
//
// Defense: every unsafe-method request must carry an Origin (preferred)
// or Referer header that resolves to one of the configured CORS_ORIGINS.
// Same-origin requests in modern browsers always include Origin on POST,
// so legitimate traffic is unaffected.

import fp from "fastify-plugin";
import { ForbiddenError } from "../lib/errors.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export default fp<{ allowedOrigins: string[] }>(async (app, opts) => {
  const allowed = new Set(opts.allowedOrigins.map(normalize));

  app.addHook("preHandler", async (request) => {
    if (!UNSAFE_METHODS.has(request.method)) return;

    const origin = headerString(request.headers.origin);
    const referer = headerString(request.headers.referer);

    // Pick the first one we have. Browsers always send Origin on POST,
    // so the absence of both is itself suspicious for a state-changing
    // request — reject. (Server-to-server callers should set Origin.)
    const candidate = origin ?? refererOrigin(referer);
    if (!candidate) {
      throw new ForbiddenError(
        "missing_origin",
        "missing_origin_on_state_changing_request",
      );
    }
    if (!allowed.has(normalize(candidate))) {
      throw new ForbiddenError(
        "origin_not_allowed",
        "origin_not_allowed",
      );
    }
  });
});

function headerString(v: string | string[] | undefined): string | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function refererOrigin(referer: string | null): string | null {
  if (!referer) return null;
  try {
    const u = new URL(referer);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function normalize(origin: string): string {
  // Strip a trailing slash and lowercase the host. Origins from CORS
  // config are typically already canonical, but operators sometimes
  // paste with a stray slash.
  try {
    const u = new URL(origin);
    return `${u.protocol}//${u.host.toLowerCase()}`;
  } catch {
    return origin.toLowerCase().replace(/\/+$/, "");
  }
}
