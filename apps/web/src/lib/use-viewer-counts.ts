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
      fetchViewerCounts(ids)
        .then((next) => {
          if (cancelled) return;
          setCounts(next);
        })
        .catch(() => {
          // Best-effort: a transient failure shouldn't blank the
          // pills (would visibly flicker). Leave stale counts in
          // place; the next interval tries again.
        });
    };

    run();
    const timer = setInterval(run, VIEWER_COUNTS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key]);

  return counts;
}
