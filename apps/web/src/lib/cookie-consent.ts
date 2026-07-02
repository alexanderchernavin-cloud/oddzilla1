"use client";

// Cookie acknowledgment store.
//
// Operator decision (2026-07-02, UZ-market product call): the banner is
// ACCEPTANCE-ONLY — it offers two "Accept all" buttons and no reject
// path. Clicking either accepts every category. The store still gates
// the two non-essential surfaces (third-party embedded media + the
// fe-analytics tracker) until the visitor has clicked accept, so
// nothing loads behind an unanswered banner.
//
// Guardrail for future edits: the buttons say "Accept all" and that is
// exactly what they do — label and behaviour match. If a Reject /
// "Necessary only" option is ever reintroduced, it MUST genuinely
// disable the categories. A reject-labelled control that accepts is
// deceptive design; do not wire one up.
//
// Storage: localStorage["oz:cookie-consent"], same `oz:` prefix as the
// theme toggle. v bumped 1 → 2 when the banner went acceptance-only so
// choices stored by the short-lived v1 banner (including declines) are
// re-asked instead of silently carried forward. Cross-component sync
// via a window event so the banner and every gated embed re-render the
// moment the visitor accepts.

import { useEffect, useState } from "react";

const STORAGE_KEY = "oz:cookie-consent";
const CHANGED_EVENT = "oz:cookie-consent-changed";

export interface CookieConsent {
  v: 2;
  // Third-party embedded media (streams + widgets) allowed.
  embeds: boolean;
  // First-party analytics (fe-analytics tracker) allowed.
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
    // Unknown or older shape — treat as unanswered so the banner shows
    // again rather than assuming an answer from a different regime.
    return null;
  } catch {
    // localStorage may throw in restrictive contexts — treat as unanswered.
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

/**
 * Hook: true once the visitor has accepted (embeds allowed). Unanswered
 * counts as NOT allowed — nothing non-essential loads behind an
 * unanswered banner.
 */
export function useEmbedsAllowed(): boolean {
  const { consent } = useCookieConsent();
  return consent?.embeds === true;
}
