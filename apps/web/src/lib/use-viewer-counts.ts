"use client";

// Batch hook that polls `/live-chat/viewers` for the listed matches.
//
// Polling cadence is intentionally slow (default 30 s) — list pages
// are browsing surfaces, not live action; sub-second freshness is
// overkill and would cost a permanent fetch+/30s × N tabs of strain
// on api/Redis. The match-room itself subscribes via WS for true
// real-time counts on the inside.

import { useEffect, useState } from "react";
import { fetchViewerCounts } from "./live-chat-client";

export const VIEWER_COUNTS_POLL_MS = 30_000;

// Shallow value-equality on the counts map so an unchanged poll result
// keeps the previous object reference (no list re-render).
function sameCounts(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

export function useViewerCountsForMatches(
  matchIds: readonly string[],
): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});

  // Stable join key so resubscription is keyed on the *set* of
  // matches, not array identity — same pattern useLiveOddsForMatches
  // uses.
  const key = [...matchIds].sort().join(",");

  useEffect(() => {
    if (key === "") {
      setCounts({});
      return;
    }
    let cancelled = false;
    const ids = key.split(",");

    const run = () => {
      // Don't poll a backgrounded tab — viewer counts are ambient
      // browsing decoration, not something the user is watching when the
      // tab isn't focused.
      if (document.visibilityState === "hidden") return;
      fetchViewerCounts(ids)
        .then((next) => {
          if (cancelled) return;
          // Only re-render when a count actually changed. setCounts always
          // installs a fresh object otherwise, re-rendering the whole match
          // list every 30 s even when every count is identical (the common
          // case on a quiet slate).
          setCounts((prev) => (sameCounts(prev, next) ? prev : next));
        })
        .catch(() => {
          // Best-effort: a transient failure shouldn't blank the
          // pills (would visibly flicker). Leave stale counts in
          // place; the next interval tries again.
        });
    };

    run();
    const timer = setInterval(run, VIEWER_COUNTS_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key]);

  return counts;
}
