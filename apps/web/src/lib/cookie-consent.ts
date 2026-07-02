"use client";

// Cookie-consent store (GDPR / ePrivacy).
//
// The storefront sets only strictly necessary first-party cookies
// (auth session, locale) and localStorage preferences (theme, slip
// currency) — those are exempt from consent under ePrivacy art. 5(3).
// The single non-essential category is THIRD-PARTY EMBEDDED MEDIA:
// live-stream players (Twitch / YouTube / Kick / Gjirafa) and Oddin
// Disir statistics widgets, all cross-origin iframes that can set
// their own cookies the moment they load. Consent therefore gates
// whether those iframes mount at all — see `match-streams.tsx` and
// `disir-widget.tsx`.
//
// The stored choice is honest: "Necessary only" really disables the
// embeds. Do NOT change a rejection into an implicit accept — a
// consent record that doesn't match observable behaviour is the
// canonical GDPR dark-pattern regulators fine for, and it would
// invalidate every consent collected through this banner.
//
// Storage: localStorage["oz:cookie-consent"], same `oz:` prefix as
// the theme toggle. Cross-component sync via a window CustomEvent so
// the banner, the footer button, and every gated embed re-render the
// moment the user decides.

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "oz:cookie-consent";
const CHANGED_EVENT = "oz:cookie-consent-changed";
const REOPEN_EVENT = "oz:cookie-consent-reopen";

export interface CookieConsent {
  v: 1;
  // Third-party embedded media (streams + widgets) allowed.
  embeds: boolean;
  decidedAt: string;
}

export function readConsent(): CookieConsent | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CookieConsent;
    if (parsed && parsed.v === 1 && typeof parsed.embeds === "boolean") {
      return parsed;
    }
    return null;
  } catch {
    // localStorage may throw in restrictive contexts — treat as undecided.
    return null;
  }
}

export function writeConsent(embeds: boolean): void {
  if (typeof window === "undefined") return;
  const value: CookieConsent = {
    v: 1,
    embeds,
    decidedAt: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // ignore — the in-tab event below still updates the current session
  }
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

// Re-open the banner so the user can change or withdraw consent (GDPR
// art. 7(3): withdrawing must be as easy as giving). The stored choice
// stays in force until they pick again.
export function requestConsentReopen(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(REOPEN_EVENT));
}

/**
 * Hook: current consent state, hydration-safe.
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
    // `storage` fires when another tab changes the choice.
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return { ready, consent };
}

/**
 * Hook: true only when the user has affirmatively allowed third-party
 * embedded media. Undecided (no banner answer yet) counts as NOT
 * allowed — no non-essential cookies before consent.
 */
export function useEmbedsAllowed(): boolean {
  const { consent } = useCookieConsent();
  return consent?.embeds === true;
}

/** Hook used by the banner: fires `cb` when a reopen is requested. */
export function useConsentReopenListener(cb: () => void): void {
  const stable = useCallback(cb, [cb]);
  useEffect(() => {
    window.addEventListener(REOPEN_EVENT, stable);
    return () => window.removeEventListener(REOPEN_EVENT, stable);
  }, [stable]);
}
