"use client";

// The match list's Default / Pro layout preference, and how the server
// learns it before the first paint.
//
// The preference's source of truth is localStorage, namespaced per
// signed-in bettor (see match-list-tabs.tsx) — which the server cannot
// read. Read in an effect, that meant SSR always rendered the Default
// cards and a Pro user watched three cards flip into eleven rows on
// every navigation. The two-column toggle has the same shape and the
// codebase accepted it there, because that control is invisible below
// 2000px; a card-to-table flip is visible on every screen.
//
// So the toggle ALSO writes a cookie, the (main) layout reads it on the
// server and provides it here, and MatchListTabs seeds its state from
// it — so SSR and the client's first render agree, and the localStorage
// effect only ever corrects the rare shared-browser case (two bettors,
// one browser, different choices: the cookie says whoever toggled last,
// the effect flips to the signed-in bettor's own value). Same reason the
// theme has a pre-hydration boot script; a cookie is the SSR-side
// equivalent for state that changes the component TREE rather than a
// stylesheet.
//
// Host-scoped (no Domain attribute), like the auth cookies since
// 2026-05-18 and unlike the locale cookie, which deliberately spans
// subdomains: the admin backoffice has no match list, so there is
// nothing for it to share. Not HttpOnly — the client writes it. It is a
// display preference, not a credential; a forged value can only pick a
// layout.
//
// The cookie's NAME, TYPE and PARSER live in lib/list-layout-cookie.ts,
// a plain module, because the server layout needs them too and a value
// exported from this "use client" file would reach it as a
// client-reference proxy (the `nextjs-client-boundary-values` footgun;
// it threw on the first real request of the first cut). Re-exported
// here so client code has one import.

import { createContext, useContext, type ReactNode } from "react";
import { LIST_LAYOUT_COOKIE, type ListLayoutMode } from "./list-layout-cookie";

export {
  LIST_LAYOUT_COOKIE,
  parseListLayoutCookie,
  type ListLayoutMode,
} from "./list-layout-cookie";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Client-side write; the server reads it on the next navigation. */
export function writeListLayoutCookie(mode: ListLayoutMode): void {
  try {
    document.cookie = `${LIST_LAYOUT_COOKIE}=${mode}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
  } catch {
    // A browser refusing cookie writes just keeps the effect-time
    // correction, which is the pre-cookie behaviour.
  }
}

const ListLayoutContext = createContext<ListLayoutMode>("default");

/** Provided by the (main) layout from the cookie the server saw. */
export function ListLayoutProvider({
  initial,
  children,
}: {
  initial: ListLayoutMode;
  children: ReactNode;
}) {
  return (
    <ListLayoutContext.Provider value={initial}>{children}</ListLayoutContext.Provider>
  );
}

/**
 * The layout the SERVER rendered with. Use it to seed state, never as
 * the live value — the toggle and the per-bettor localStorage move on
 * without updating this.
 */
export function useInitialListLayout(): ListLayoutMode {
  return useContext(ListLayoutContext);
}
