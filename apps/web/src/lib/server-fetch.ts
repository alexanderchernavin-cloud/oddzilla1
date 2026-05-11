import "server-only";
import { cookies, headers } from "next/headers";
import { AUTH_COOKIE_NAMES } from "@/lib/auth";

const REQUEST_ID_HEADER = "x-request-id";

/**
 * Server-side fetch to the API. Forwards auth cookies if present. Returns
 * `null` on non-2xx instead of throwing, so pages can render a fallback.
 * Catalog endpoints are public, but forwarding cookies doesn't hurt.
 *
 * Also forwards `x-request-id` from the inbound request — the middleware
 * generates (or echoes) one per page render, and the API's `genReqId`
 * picks it up so a single grep finds the SSR render and every API call
 * it triggered across both web and api log streams.
 */
export async function serverApi<T>(path: string): Promise<T | null> {
  const store = await cookies();
  const cookieHeader = Object.values(AUTH_COOKIE_NAMES)
    .map((n) => store.get(n))
    .filter((c): c is { name: string; value: string } => Boolean(c))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  const requestHeaders = await headers();
  const requestId = requestHeaders.get(REQUEST_ID_HEADER);

  const apiUrl =
    process.env.INTERNAL_API_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://api:3001";
  try {
    const res = await fetch(`${apiUrl}${path}`, {
      headers: {
        accept: "application/json",
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
        ...(requestId ? { [REQUEST_ID_HEADER]: requestId } : {}),
      },
      cache: "no-store",
    });
    if (!res.ok) {
      // Surface non-2xx in operator logs — without this, pages render
      // empty fallbacks during an api outage and ops has no signal.
      // Don't expose path-querystring details that might carry user
      // identifiers; the path component is enough to triage.
      console.error(
        JSON.stringify({
          service: "web",
          event: "server_fetch_non2xx",
          path,
          status: res.status,
          requestId,
          replica: process.env.REPLICA_NAME ?? "web",
        }),
      );
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(
      JSON.stringify({
        service: "web",
        event: "server_fetch_error",
        path,
        requestId,
        replica: process.env.REPLICA_NAME ?? "web",
        error: (err as Error).message,
      }),
    );
    return null;
  }
}
