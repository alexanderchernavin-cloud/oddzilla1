// Server-side auth helpers. Only usable from Server Components, Server
// Actions, and Route Handlers. Never import this from a "use client" file.

import "server-only";
import { cookies } from "next/headers";
import { secretKey, verifyAccessToken, type AccessTokenClaims } from "@oddzilla/auth/jwt";

const ACCESS_COOKIE = "oddzilla_access";
const REFRESH_COOKIE = "oddzilla_refresh";

function jwtSecret(): Uint8Array {
  const raw = process.env.JWT_SECRET;
  if (!raw) {
    throw new Error(
      "JWT_SECRET is required in apps/web (same value as services/api).",
    );
  }
  return secretKey(raw);
}

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
 * Verifies the access cookie locally using the shared JWT secret. Fast and
 * does not hit the API. Returns the raw claims or null if missing/invalid.
 */
export async function getSessionClaims(): Promise<AccessTokenClaims | null> {
  const store = await cookies();
  const token = store.get(ACCESS_COOKIE)?.value;
  if (!token) return null;
  try {
    return await verifyAccessToken(token, jwtSecret());
  } catch {
    return null;
  }
}

/**
 * Calls the API's /auth/me with the current request's cookies forwarded.
 * Returns the full user or null. More expensive than getSessionClaims() —
 * use only when you need profile fields beyond id/role.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const cookieHeader = [ACCESS_COOKIE, REFRESH_COOKIE]
    .map((n) => store.get(n))
    .filter((c): c is { name: string; value: string } => Boolean(c))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  if (!cookieHeader) return null;

  const apiUrl = process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://api:3001";
  try {
    const res = await fetch(`${apiUrl}/auth/me`, {
      headers: { cookie: cookieHeader, accept: "application/json" },
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
