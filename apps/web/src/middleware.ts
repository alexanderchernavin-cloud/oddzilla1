// Edge middleware. Two responsibilities:
//
//   1. Silent refresh. The 15-minute access cookie expires often; without a
//      refresh on every page the user is "kicked out". When the access cookie
//      is missing but the refresh cookie is present, we call the API's
//      /auth/refresh server-side, forward the rotated Set-Cookie headers to
//      the browser, and rewrite the request cookies so the SSR layout's
//      /auth/me call (in lib/auth.ts) sees the new token in the SAME render —
//      no flicker of logged-out state.
//
//   2. Protected-route gate. After the refresh attempt, if there is still no
//      session, /account, /wallet, /bets, /admin redirect to /login.
//      Public pages (home, /sport/:slug, /match/:id) render logged-out.
//
// The middleware runs on every page route (not on /api/* — Caddy proxies
// those directly to api:3001 and Next.js never sees them).

import { NextResponse, type NextRequest } from "next/server";

const ACCESS_COOKIE = "oddzilla_access";
const REFRESH_COOKIE = "oddzilla_refresh";

const PROTECTED_PREFIXES = ["/account", "/wallet", "/bets", "/admin"];

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

function internalApiUrl(): string {
  // Server-side fetch from middleware. In Docker compose, INTERNAL_API_URL is
  // set to http://api:3001. In local dev (no INTERNAL_API_URL), fall back to
  // NEXT_PUBLIC_API_URL or localhost.
  const internal = process.env.INTERNAL_API_URL;
  if (internal && internal.length > 0) return internal;
  const pub = process.env.NEXT_PUBLIC_API_URL;
  if (pub && pub.length > 0) return pub;
  return "http://api:3001";
}

/**
 * Extract the value of a single cookie out of a Set-Cookie header line. We
 * deliberately do not parse attributes — we just need the name/value to
 * forward into the request cookie jar so server components see it on the
 * same render as the response that sets it on the browser.
 */
function readSetCookieValue(setCookie: string, name: string): string | null {
  const eq = setCookie.indexOf("=");
  if (eq === -1) return null;
  const cookieName = setCookie.slice(0, eq).trim();
  if (cookieName !== name) return null;
  const rest = setCookie.slice(eq + 1);
  const semi = rest.indexOf(";");
  return semi === -1 ? rest : rest.slice(0, semi);
}

function getSetCookieHeaders(headers: Headers): string[] {
  // Node 20+/undici and Edge runtime support Headers.getSetCookie(). Fall
  // back to a single comma-joined value as a defensive read; in practice
  // the modern path is always available.
  const anyHeaders = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

export async function middleware(req: NextRequest) {
  const access = req.cookies.get(ACCESS_COOKIE);
  if (access) {
    return NextResponse.next();
  }

  const refresh = req.cookies.get(REFRESH_COOKIE);
  if (refresh) {
    try {
      const apiRes = await fetch(`${internalApiUrl()}/auth/refresh`, {
        method: "POST",
        headers: {
          cookie: `${REFRESH_COOKIE}=${refresh.value}`,
          accept: "application/json",
        },
      });
      if (apiRes.ok) {
        const setCookies = getSetCookieHeaders(apiRes.headers);
        // Pull the new cookie values so we can rewrite the inbound request
        // cookies — that way the SSR layout's getSessionUser() call sees the
        // refreshed access token immediately, with no flicker.
        let newAccess: string | null = null;
        let newRefresh: string | null = null;
        for (const sc of setCookies) {
          newAccess = newAccess ?? readSetCookieValue(sc, ACCESS_COOKIE);
          newRefresh = newRefresh ?? readSetCookieValue(sc, REFRESH_COOKIE);
        }

        // Build a new request cookie header that reflects the rotated values.
        const reqCookies: string[] = [];
        for (const c of req.cookies.getAll()) {
          if (c.name === ACCESS_COOKIE || c.name === REFRESH_COOKIE) continue;
          reqCookies.push(`${c.name}=${c.value}`);
        }
        if (newAccess) reqCookies.push(`${ACCESS_COOKIE}=${newAccess}`);
        if (newRefresh) reqCookies.push(`${REFRESH_COOKIE}=${newRefresh}`);

        const requestHeaders = new Headers(req.headers);
        if (reqCookies.length > 0) {
          requestHeaders.set("cookie", reqCookies.join("; "));
        } else {
          requestHeaders.delete("cookie");
        }

        const response = NextResponse.next({
          request: { headers: requestHeaders },
        });
        for (const sc of setCookies) {
          response.headers.append("set-cookie", sc);
        }
        return response;
      }
    } catch {
      // Network blip or API down — fall through to the no-session path.
    }
  }

  // No valid session — gate protected routes, let public routes render.
  if (isProtectedPath(req.nextUrl.pathname)) {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
    const redirect = NextResponse.redirect(url);
    redirect.cookies.delete(ACCESS_COOKIE);
    redirect.cookies.delete(REFRESH_COOKIE);
    return redirect;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Run on every page route. Skip Next internals, static assets, and the
    // /api and /ws pass-throughs (Caddy handles those before Next sees them,
    // but we still exclude them defensively for local `next dev`).
    "/((?!_next/static|_next/image|api/|ws|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|woff2?|map|txt|xml)).*)",
  ],
};
