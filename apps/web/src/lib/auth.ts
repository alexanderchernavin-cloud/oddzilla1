// Server-side auth helpers. Only usable from Server Components, Server
// Actions, and Route Handlers. Never import this from a "use client" file.
//
// We deliberately do NOT verify access tokens locally here — that would
// require sharing JWT_SECRET with the web container and turn a web RCE
// into the ability to mint admin tokens. Instead every session check
// goes through the API's /auth/me endpoint, which already does
// signature + audience + revocation verification.

import "server-only";
import { cookies } from "next/headers";

const ACCESS_COOKIE = "oddzilla_access";
const REFRESH_COOKIE = "oddzilla_refresh";

export interface SessionUser {
  id: string;
  email: string;
  role: "user" | "admin" | "support";
  status: "active" | "blocked" | "pending_kyc";
  kycStatus: "none" | "pending" | "approved" | "rejected";
  displayName: string | null;
  countryCode: string | null;
}

/**
 * Calls the API's /auth/me with the current request's cookies forwarded.
 * Returns the full user or null. This is the only auth check available
 * to the web container — there is no offline JWT verification path so a
 * compromised web server cannot forge a valid token.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const cookieHeader = [ACCESS_COOKIE, REFRESH_COOKIE]
    .map((n) => store.get(n))
    .filter((c): c is { name: string; value: string } => Boolean(c))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  if (!cookieHeader) return null;

  const apiUrl = process.env.INTERNAL_API_URL ?? "http://api:3001";
  try {
    const res = await fetch(`${apiUrl}/auth/me`, {
      headers: {
        cookie: cookieHeader,
        accept: "application/json",
        // Origin matches CORS_ORIGINS so the API's CSRF preHandler accepts
        // this server-to-server call. We pick whichever frontend host
        // the runtime tells us about; falling back to a placeholder
        // for local dev.
        origin: process.env.FRONTEND_HOST
          ? `https://${process.env.FRONTEND_HOST}`
          : "http://localhost:3000",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { user: SessionUser };
    return data.user;
  } catch {
    return null;
  }
}

export const AUTH_COOKIE_NAMES = {
  access: ACCESS_COOKIE,
  refresh: REFRESH_COOKIE,
};

/**
 * Validates a `?next=` redirect target. Open-redirect protection: only
 * paths starting with `/` are accepted, AND the second character must
 * not be `/` or `\` (which would be parsed as a protocol-relative URL,
 * navigating to an attacker host).
 */
export function safeNextPath(next: string | undefined, fallback: string): string {
  if (!next) return fallback;
  if (!next.startsWith("/")) return fallback;
  if (next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
