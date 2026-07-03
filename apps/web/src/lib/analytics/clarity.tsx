"use client";

// Microsoft Clarity loader (operator-requested third-party session
// analytics, project xgm8u7isgt — the id is public by design, it ships
// in every page's HTML on any Clarity site).
//
// Same consent regime as the first-party tracker: nothing loads until
// the cookie banner's analytics category is granted. Once loaded it
// stays for the page lifetime (the acceptance-only banner has no
// withdrawal path today).
//
// No inline <script> snippet: the CSP is nonce + 'strict-dynamic', so
// a script element created by our own (nonce-trusted) bundle is
// allowed automatically — this component reproduces the official
// snippet's queue shim + async tag injection instead. connect-src for
// Clarity's beacons is whitelisted in apps/web/src/middleware.ts.
//
// Skips /admin paths (prod admin is its own host, but dev shares
// localhost — operator backoffice sessions don't belong in a
// third-party recorder) and non-production builds.

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useCookieConsent } from "@/lib/cookie-consent";

const CLARITY_PROJECT_ID = "xgm8u7isgt";

type ClarityFn = ((...args: unknown[]) => void) & { q?: unknown[][] };

declare global {
  interface Window {
    clarity?: ClarityFn;
  }
}

export function ClarityLoader() {
  const pathname = usePathname();
  const { consent } = useCookieConsent();
  const allowed = consent?.analytics === true;
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current || !allowed) return;
    if (process.env.NODE_ENV !== "production") return;
    if (!pathname || pathname.startsWith("/admin")) return;
    loadedRef.current = true;

    if (!window.clarity) {
      const shim: ClarityFn = (...args: unknown[]) => {
        (shim.q = shim.q ?? []).push(args);
      };
      window.clarity = shim;
    }
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://www.clarity.ms/tag/${CLARITY_PROJECT_ID}`;
    document.head.appendChild(s);
  }, [allowed, pathname]);

  return null;
}
