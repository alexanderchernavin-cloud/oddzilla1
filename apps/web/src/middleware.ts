// Edge middleware. Minimal presence check: if a protected route is hit
// without an access cookie, redirect to /login with a `next` param so the
// user bounces back to their intended destination after login. Role checks
// happen inside each layout (server component) where we can call the API.

import { NextResponse, type NextRequest } from "next/server";

const ACCESS_COOKIE = "oddzilla_access";

export function middleware(req: NextRequest) {
  const hasAccess = req.cookies.has(ACCESS_COOKIE);
  if (hasAccess) return NextResponse.next();

  const url = new URL("/login", req.url);
  url.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/account/:path*",
    "/wallet/:path*",
    "/bets/:path*",
    "/admin/:path*",
  ],
};
