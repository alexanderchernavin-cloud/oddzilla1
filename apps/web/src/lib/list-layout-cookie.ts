// The match-list layout cookie: name, value type, and the parser.
//
// A PLAIN module on purpose — no "use client". The (main) layout, a
// server component, calls `parseListLayoutCookie` on the request's
// cookie; the toggle, a client component, writes the same cookie. A
// value exported from a "use client" module reaches a server component
// as a client-reference proxy, not the value, and calling it throws
// only on a real request — tsc, next build and CI all pass. That is the
// `nextjs-client-boundary-values` footgun, and this split is the fix:
// the provider, hook and cookie WRITER live in lib/list-layout.tsx
// (client), everything a server component needs lives here.

export type ListLayoutMode = "default" | "pro";

export const LIST_LAYOUT_COOKIE = "oz_list_layout";

/**
 * Turns a raw cookie value into a layout, defaulting to "default" for
 * anything unrecognised — so nobody is switched into a layout they
 * never picked by a stale or mangled cookie.
 */
export function parseListLayoutCookie(
  value: string | null | undefined,
): ListLayoutMode {
  return value === "pro" ? "pro" : "default";
}
