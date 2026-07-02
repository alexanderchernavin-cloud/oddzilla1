"use client";

// Null-rendering mount point for the FE analytics tracker (see
// ./tracker.ts). Lives in the ROOT layout so storefront + auth pages
// are covered; /admin paths are filtered inside the tracker (prod admin
// is a separate host anyway).
//
// Capture is consent-gated: the tracker records nothing until the
// cookie banner's "analytics" category is granted, and withdrawing
// consent drops the queued data plus the stored session id. The
// listeners still attach on mount — they no-op behind the gate — so
// granting consent starts tracking without a reload.

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { analyticsTracker } from "./tracker";
import { useCookieConsent } from "@/lib/cookie-consent";

export function AnalyticsTracker() {
  const pathname = usePathname();
  const { consent } = useCookieConsent();
  const analyticsAllowed = consent?.analytics === true;
  const prevAllowed = useRef(false);

  useEffect(() => {
    analyticsTracker.init();
  }, []);

  useEffect(() => {
    analyticsTracker.setConsent(analyticsAllowed);
    // Record the page the user is on when consent is granted —
    // otherwise the session's first page_view only lands on the next
    // navigation. The prev-value guard keeps route changes (which
    // re-run this effect via the pathname dep) from double-counting:
    // those are handled by the pageView effect below.
    if (analyticsAllowed && !prevAllowed.current && pathname) {
      analyticsTracker.pageView(pathname);
    }
    prevAllowed.current = analyticsAllowed;
  }, [analyticsAllowed, pathname]);

  useEffect(() => {
    if (pathname) analyticsTracker.pageView(pathname);
  }, [pathname]);

  return null;
}
