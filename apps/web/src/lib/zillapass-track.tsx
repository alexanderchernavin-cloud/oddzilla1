"use client";

// Client-side ZillaPass event tracker. Sport / match page mounts fire
// a single fetch to POST /zillapass/track. Signed-out viewers no-op
// (the endpoint requires auth anyway, no point making the request).
//
// In-memory dedup keeps repeat navs cheap: opening CS2 → Dota2 → CS2
// only POSTs twice. Dedup resets on full page reload, which is fine —
// the server-side reducer is idempotent (it stores a set; re-adding
// the same slug doesn't grow the count).
//
// Each successful POST returns the FRESH /zillapass/me shape inline.
// The tracker hands it to the shared ZillapassProvider via setData()
// so the top-bar chip flips its progress bar in the same tick — no
// 30 s wait for the background poll.

import { useCallback, useEffect } from "react";
import type { ZillapassMeResponse } from "@oddzilla/types";
import { clientApi } from "@/lib/api-client";
import { useSessionUserId } from "@/lib/session-user";
import { useZillapass } from "@/lib/zillapass";

const sent = new Set<string>();

async function track(
  payload: Record<string, unknown>,
): Promise<ZillapassMeResponse | null> {
  try {
    return await clientApi<ZillapassMeResponse>("/zillapass/track", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } catch {
    // Best-effort — engagement nudge should never surface as a UI
    // error. The server-side writer also swallows + logs.
    return null;
  }
}

export function SportViewTracker({ sportSlug }: { sportSlug: string }) {
  const userId = useSessionUserId();
  const { setData } = useZillapass();
  useEffect(() => {
    if (!userId) return;
    const key = `sport:${sportSlug}`;
    if (sent.has(key)) return;
    sent.add(key);
    void (async () => {
      const next = await track({ event: "sport_view", sportSlug });
      if (next) setData(next);
    })();
  }, [userId, sportSlug, setData]);
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
  const { setData } = useZillapass();
  useEffect(() => {
    if (!userId) return;
    const key = `match:${matchId}`;
    if (sent.has(key)) return;
    sent.add(key);
    void (async () => {
      const next = await track({ event: "match_view", matchId, sportSlug });
      if (next) setData(next);
    })();
  }, [userId, matchId, sportSlug, setData]);
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
  const { setData } = useZillapass();
  return useCallback(() => {
    if (!userId) return;
    void (async () => {
      const next = await track({ event: "market_tab_change" });
      if (next) setData(next);
    })();
  }, [userId, setData]);
}
