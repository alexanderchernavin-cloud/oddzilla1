// Account namespace derivation. The same email can back two rows in
// `users` (a bettor and an admin) since migration 0065 — partial unique
// indexes scope the email uniqueness by role. Login flows pick which
// namespace to authenticate against based on which subdomain the
// request came from, NOT from a hidden form field or a user-chosen
// radio button: every relevant production host already announces the
// intended namespace via its hostname.
//
//   * `oddzilla.cc`         → bettor namespace (users where role = 'user')
//   * `sadmin.oddzilla.cc`  → admin namespace  (users where role IN ('admin','support'))
//
// Dev hosts:
//   * `localhost`           → bettor (default)
//   * `admin.localhost`     → admin
//
// CSRF already gates POST/PUT/PATCH/DELETE by Origin against
// CORS_ORIGINS, so a malicious site can't reach /auth/login at all —
// the host we read here is therefore one of the known operator hosts.

import type { FastifyRequest } from "fastify";

export type AccountNamespace = "bettor" | "admin";

const ADMIN_SUBDOMAIN_PREFIXES = ["sadmin.", "admin."];

/**
 * Read the request host (X-Forwarded-Host first, then Host) and map it
 * to a namespace. Strips the port and lowercases. Unknown hosts fall
 * back to `bettor` — the storefront is the larger surface and the
 * least-privilege default if anything ever bypasses CSRF.
 */
export function accountNamespaceFromRequest(request: FastifyRequest): AccountNamespace {
  const xfh = request.headers["x-forwarded-host"];
  const xfhFirst = Array.isArray(xfh) ? xfh[0] : xfh;
  const host = (xfhFirst ?? request.headers.host ?? "").split(",")[0]?.trim() ?? "";
  const hostname = host.split(":")[0]!.toLowerCase();
  if (ADMIN_SUBDOMAIN_PREFIXES.some((p) => hostname.startsWith(p))) {
    return "admin";
  }
  return "bettor";
}

/**
 * The set of `users.role` values that belong to a namespace. Bettor
 * namespace contains only `'user'`; admin namespace contains the
 * admin/support staff tiers. Used in WHERE clauses that filter the
 * `users` table by which login surface the request came in on.
 */
export function rolesForNamespace(
  ns: AccountNamespace,
): readonly ("user" | "admin" | "support")[] {
  return ns === "admin" ? (["admin", "support"] as const) : (["user"] as const);
}
