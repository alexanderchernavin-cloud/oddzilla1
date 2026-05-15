"use client";

// Tiny client-side context exposing the signed-in bettor's user id.
// Set once by the (main) layout from the server-side getSessionUser()
// result; consumed by components that want to scope per-bettor UI
// state (e.g. the match-list column toggle stored in localStorage).
//
// We keep this minimal — just the id — so the broader user object
// stays on the server where it belongs. A page that needs more than
// the id (email, role, kyc status) should call getSessionUser()
// itself rather than rehydrating it from this context.

import { createContext, useContext, type ReactNode } from "react";

const SessionUserContext = createContext<string | null>(null);

export function SessionUserProvider({
  userId,
  children,
}: {
  userId: string | null;
  children: ReactNode;
}) {
  return (
    <SessionUserContext.Provider value={userId}>
      {children}
    </SessionUserContext.Provider>
  );
}

// Returns the signed-in bettor's user id, or null for anonymous
// viewers. Safe to call from any client component under the (main)
// layout; anonymous storefront pages get null without throwing.
export function useSessionUserId(): string | null {
  return useContext(SessionUserContext);
}
