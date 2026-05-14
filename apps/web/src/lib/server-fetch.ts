import "server-only";
import { cookies, headers } from "next/headers";
import { AUTH_COOKIE_NAMES } from "@/lib/auth";
import { LOCALE_COOKIE } from "@/lib/i18n";

const REQUEST_ID_HEADER = "x-request-id";

// Cookie names the SSR fetch forwards to the API. Auth cookies gate
// the session; oz_locale lets `/catalog/matches/:id` pull
// language-matched description rows so SSR-rendered market names land
// in the user's picked language instead of defaulting to English.
const FORWARD_COOKIES = [
  AUTH_COOKIE_NAMES.access,
  AUTH_COOKIE_NAMES.refresh,
  LOCALE_COOKIE,
];

/**
 * Server-side fetch to the API. Forwards auth + locale cookies if present.
 * Returns `null` on non-2xx instead of throwing, so pages can render a
 * fallback. Catalog endpoints are public, but the locale cookie still
 * matters to flip translated market names.
 *
 * Also forwards `x-request-id` from the inbound request — the middleware
 * generates (or echoes) one per page render, and the API's `genReqId`
 * picks it up so a single grep finds the SSR render and every API call
 * it triggered across both web and api log streams.
 */
export async function serverApi<T>(path: string): Promise<T | null> {
  const store = await cookies();
  const cookieHeader = FORWARD_COOKIES
    .map((n) => store.get(n))
    .filter((c): c is { name: string; value: string } => Boolean(c))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  const requestHeaders = await headers();
  const requestId = requestHeaders.get(REQUEST_ID_HEADER);

  // `??` would treat empty strings as set — but the documented
  // `.env.example` ships `NEXT_PUBLIC_API_URL=` (empty for "same
  // origin" on the browser side), so an empty INTERNAL_API_URL
  // would survive the coalesce and produce `fetch("/path")` which
  // Node rejects with `Failed to parse URL`. Mirror the pattern in
  // middleware.ts: treat empty strings as unset.
  const internal = process.env.INTERNAL_API_URL;
  const pub = process.env.NEXT_PUBLIC_API_URL;
  const apiUrl =
    internal && internal.length > 0
      ? internal
      : pub && pub.length > 0
        ? pub
        : "http://api:3001";
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
