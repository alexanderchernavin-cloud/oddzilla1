"use client";

// Cookie-notice acknowledgment store.
//
// Operator decision (2026-07-02, UZ-market product call): cookies,
// third-party embeds, and first-party analytics are ON BY DEFAULT.
// The banner is a pure informational notice — its two "Accept all"
// buttons acknowledge and dismiss it; nothing in the product is gated
// on the acknowledgment. This store only remembers whether the visitor
// has dismissed the notice so it isn't shown again.
//
// Guardrail for future edits: the banner text and /privacy describe
// tracking as on-by-default, and the buttons do exactly what they say.
// If a Reject / "Necessary only" control is ever reintroduced, it MUST
// genuinely disable the categories it claims to — a reject-labelled
// control that accepts is deceptive design; do not wire one up.
//
// Storage: localStorage["oz:cookie-consent"], same `oz:` prefix as the
// theme toggle. The v2 shape carries {embeds, analytics} booleans from
// the earlier gated regime; they are kept for record-keeping but no
// longer gate anything.

import { useEffect, useState } from "react";

const STORAGE_KEY = "oz:cookie-consent";
const CHANGED_EVENT = "oz:cookie-consent-changed";

export interface CookieConsent {
  v: 2;
  embeds: boolean;
  analytics: boolean;
  decidedAt: string;
}

export function readConsent(): CookieConsent | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CookieConsent;
    if (
      parsed &&
      parsed.v === 2 &&
      typeof parsed.embeds === "boolean" &&
      typeof parsed.analytics === "boolean"
    ) {
      return parsed;
    }
    // Unknown or older shape — treat as unacknowledged so the notice
    // shows once more.
    return null;
  } catch {
    // localStorage may throw in restrictive contexts — treat as
    // unacknowledged.
    return null;
  }
}

export function acceptAll(): void {
  if (typeof window === "undefined") return;
  const value: CookieConsent = {
    v: 2,
    embeds: true,
    analytics: true,
    decidedAt: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // ignore — the in-tab event below still updates the current session
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

/**
 * Hook: current stored acknowledgment, hydration-safe.
 * `ready` is false during SSR and the first client render, so consumers
 * can render nothing until the real value is known (avoids hydration
 * mismatches — same pattern as the email-verification banner).
 */
export function useCookieConsent(): {
  ready: boolean;
  consent: CookieConsent | null;
} {
  const [ready, setReady] = useState(false);
  const [consent, setConsent] = useState<CookieConsent | null>(null);

  useEffect(() => {
    const sync = () => setConsent(readConsent());
    sync();
    setReady(true);
    window.addEventListener(CHANGED_EVENT, sync);
    // `storage` fires when another tab stores the acknowledgment.
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return { ready, consent };
}
