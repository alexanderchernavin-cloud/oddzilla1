"use client";

// Client-side ZillaPass event tracker. Sport / match page mounts fire
// a single fetch to POST /zillapass/track. Signed-out viewers no-op
// (the endpoint requires auth anyway, no point making the request).
//
// In-memory dedup keeps repeat navs cheap: opening CS2 → Dota2 → CS2
// only POSTs twice. Dedup resets on full page reload, which is fine —
// the server-side reducer is idempotent (it stores a set; re-adding
// the same slug doesn't grow the count).

import { useEffect } from "react";
import { clientApi } from "@/lib/api-client";
import { useSessionUserId } from "@/lib/session-user";

const sent = new Set<string>();

async function track(payload: Record<string, unknown>): Promise<void> {
  try {
    await clientApi("/zillapass/track", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } catch {
    // Best-effort — engagement nudge should never surface as a UI
    // error. The server-side writer also swallows + logs.
  }
}

export function SportViewTracker({ sportSlug }: { sportSlug: string }) {
  const userId = useSessionUserId();
  useEffect(() => {
    if (!userId) return;
    const key = `sport:${sportSlug}`;
    if (sent.has(key)) return;
    sent.add(key);
    void track({ event: "sport_view", sportSlug });
  }, [userId, sportSlug]);
  return null;
}

export function MatchViewTracker({
  matchId,
  sportSlug,
}: {
  matchId: string;
  sportSlug: string;
}) {
  const userId = useSessionUserId();
  useEffect(() => {
    if (!userId) return;
    const key = `match:${matchId}`;
    if (sent.has(key)) return;
    sent.add(key);
    void track({ event: "match_view", matchId, sportSlug });
  }, [userId, matchId, sportSlug]);
  return null;
}

// Imperative tracker used by the match-page market tab toggle.
// Each user-driven tab switch fires one POST — no per-session dedup
// because the predicate counts clicks (target = 10). The server-side
// writer clamps to target_count so a chatty client tops out at the
// cap regardless. Anonymous viewers no-op (the endpoint requires
// auth, no point making the request).
export function useMarketTabChangeTracker(): () => void {
  const userId = useSessionUserId();
  return () => {
    if (!userId) return;
    void track({ event: "market_tab_change" });
  };
}
