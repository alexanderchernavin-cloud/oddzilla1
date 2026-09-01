"use client";

// useZillaBoostBanners — polls /catalog/zillaboost-banners for the
// operator-curated ZillaBoost promo banners (migration 0086). The
// payload is per-viewer (Min Risk Score gate) and its boosted prices
// are computed server-side per poll; the click-through re-validates at
// placement / lands on the match page where pricing is realtime, so a
// 10 s cadence is plenty for a lobby surface.
//
// The 1 s tick (for the ZillaFlash-style countdowns) runs only while
// some banner actually carries an end time.

import { useEffect, useMemo, useRef, useState } from "react";
import { clientApi } from "./api-client";
import type { ZillaBoostBannersResponse } from "@oddzilla/types";

const POLL_INTERVAL_MS = 10_000;
const TICK_INTERVAL_MS = 1_000;

export interface ZillaBoostBannersSnapshot extends ZillaBoostBannersResponse {
  nowMs: number;
  loaded: boolean;
}

const EMPTY: ZillaBoostBannersSnapshot = {
  sports: [],
  competitors: [],
  tournaments: [],
  matches: [],
  markets: [],
  serverNow: "",
  nowMs: 0,
  loaded: false,
};

/**
 * Lightweight variant for the sidebar: just the set of sport slugs
 * carrying a banner-enabled sport boost (renders the bolt icon next to
 * the sport). Polls the same endpoint on a slow cadence — sport rules
 * change on operator timescales.
 */
export function useZillaBoostSportSet(pollMs = 60_000): Set<string> {
  const [slugs, setSlugs] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fetchOnce = async () => {
      try {
        const res = await clientApi<ZillaBoostBannersResponse>(
          "/catalog/zillaboost-banners",
        );
        if (cancelled) return;
        setSlugs((prev) => {
          const next = new Set(res.sports.map((s) => s.slug));
          if (next.size === prev.size && [...next].every((s) => prev.has(s))) {
            return prev; // no re-render churn
          }
          return next;
        });
      } catch {
        // keep previous set
      } finally {
        if (!cancelled) timer = setTimeout(fetchOnce, pollMs);
      }
    };
    void fetchOnce();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pollMs]);
  return slugs;
}

export function useZillaBoostBanners(): ZillaBoostBannersSnapshot {
  const [data, setData] = useState<ZillaBoostBannersResponse | null>(null);
  const skewMs = useRef(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fetchOnce = async () => {
      try {
        const res = await clientApi<ZillaBoostBannersResponse>(
          "/catalog/zillaboost-banners",
        );
        if (cancelled) return;
        skewMs.current = new Date(res.serverNow).getTime() - Date.now();
        setData(res);
      } catch {
        // Network blip — keep the previous snapshot, retry next tick.
      } finally {
        if (!cancelled) timer = setTimeout(fetchOnce, POLL_INTERVAL_MS);
      }
    };
    void fetchOnce();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const hasTimed =
    (data?.tournaments ?? []).some((b) => b.endsAt !== null) ||
    (data?.matches ?? []).some((b) => b.endsAt !== null) ||
    (data?.markets ?? []).some((b) => b.endsAt !== null);
  useEffect(() => {
    if (!hasTimed) return;
    const t = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      setTick((n) => n + 1);
    }, TICK_INTERVAL_MS);
    return () => clearInterval(t);
  }, [hasTimed]);
  void tick;

  return useMemo(() => {
    if (!data) return EMPTY;
    const nowMs = Date.now() + skewMs.current;
    // Client-side expiry between polls: a banner whose endsAt passed
    // drops immediately.
    const fresh = <T extends { endsAt: string | null }>(list: T[]) =>
      list.filter(
        (b) => b.endsAt === null || new Date(b.endsAt).getTime() > nowMs,
      );
    return {
      // Sport banners carry endsAt too (they render a countdown chip and
      // a home banner, not just the sidebar bolt), so they expire between
      // polls like every other scope.
      sports: fresh(data.sports),
      competitors: fresh(data.competitors),
      tournaments: fresh(data.tournaments),
      matches: fresh(data.matches),
      markets: fresh(data.markets),
      serverNow: data.serverNow,
      nowMs,
      loaded: true,
    };
  }, [data, tick]);
}
