"use client";

// Null-rendering mount point for the FE analytics tracker (see
// ./tracker.ts). Lives in the ROOT layout so storefront + auth pages
// are covered; /admin paths are filtered inside the tracker (prod admin
// is a separate host anyway).

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { analyticsTracker } from "./tracker";

export function AnalyticsTracker() {
  const pathname = usePathname();

  useEffect(() => {
    analyticsTracker.init();
  }, []);

  useEffect(() => {
    if (pathname) analyticsTracker.pageView(pathname);
  }, [pathname]);

  return null;
}
