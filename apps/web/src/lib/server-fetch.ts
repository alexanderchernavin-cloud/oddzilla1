import "server-only";
import { cookies } from "next/headers";
import { AUTH_COOKIE_NAMES } from "@/lib/auth";

/**
 * Server-side fetch to the API. Forwards auth cookies if present. Returns
 * `null` on non-2xx instead of throwing, so pages can render a fallback.
 * Catalog endpoints are public, but forwarding cookies doesn't hurt.
 */
export async function serverApi<T>(path: string): Promise<T | null> {
  const store = await cookies();
  const cookieHeader = Object.values(AUTH_COOKIE_NAMES)
    .map((n) => store.get(n))
    .filter((c): c is { name: string; value: string } => Boolean(c))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  const apiUrl =
    process.env.INTERNAL_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://api:3001";
  try {
    const res = await fetch(`${apiUrl}${path}`, {
      headers: {
        accept: "application/json",
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
