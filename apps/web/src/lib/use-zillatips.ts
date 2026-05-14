"use client";

// useZillaTips — client-side hook that fetches the per-market historical
// ROI bundle for a match exactly once on mount, then exposes a
// per-marketId lookup. Returns an empty map until the fetch resolves
// (or fails); the storefront treats a missing key as "no tip".
//
// The request runs in parallel with the SSR match-detail render so the
// tip widget rendering is bounded by network rather than waiting on
// React to mount the live-markets tree.

import { useEffect, useMemo, useState } from "react";
import { clientApi } from "./api-client";
import type {
  ZillaTip,
  ZillaTipsResponse,
} from "@oddzilla/types/zillatips";

interface ZillaTipsState {
  tipsByMarket: Map<string, ZillaTip[]>;
  loaded: boolean;
}

const EMPTY_STATE: ZillaTipsState = {
  tipsByMarket: new Map(),
  loaded: false,
};

export function useZillaTips(matchId: string): ZillaTipsState {
  const [state, setState] = useState<ZillaTipsState>(EMPTY_STATE);

  useEffect(() => {
    let cancelled = false;
    setState(EMPTY_STATE);
    clientApi<ZillaTipsResponse>(`/catalog/matches/${matchId}/zillatips`)
      .then((res) => {
        if (cancelled) return;
        const map = new Map<string, ZillaTip[]>();
        for (const t of res.tips) {
          const bucket = map.get(t.marketId);
          if (bucket) bucket.push(t);
          else map.set(t.marketId, [t]);
        }
        setState({ tipsByMarket: map, loaded: true });
      })
      .catch(() => {
        // Failure is non-fatal — the widget just doesn't render. We
        // don't surface an error toast for a non-essential overlay.
        if (cancelled) return;
        setState({ tipsByMarket: new Map(), loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  return state;
}

// Pure helper: pick the best-ROI tip from a market's tip array. Used
// by the badge label so the highest-impact ROI drives the visual tier.
export function bestTip(tips: ZillaTip[] | undefined): ZillaTip | null {
  if (!tips || tips.length === 0) return null;
  let best = tips[0]!;
  for (let i = 1; i < tips.length; i++) {
    const candidate = tips[i]!;
    if (candidate.roi > best.roi) best = candidate;
  }
  return best;
}

// Tip lookup with a stable empty fallback so callers can destructure
// without an explicit existence check.
export function tipsFor(
  tipsByMarket: Map<string, ZillaTip[]>,
  marketId: string,
): ZillaTip[] {
  return tipsByMarket.get(marketId) ?? EMPTY_TIPS;
}

const EMPTY_TIPS: ZillaTip[] = [];

// Memoised "best tip" across a set of markets (e.g. every line in a
// LineFamily). Returns null when no market in the set has a tip.
export function useBestTipAcrossMarkets(
  tipsByMarket: Map<string, ZillaTip[]>,
  marketIds: string[],
): ZillaTip | null {
  return useMemo(() => {
    let best: ZillaTip | null = null;
    for (const id of marketIds) {
      const tip = bestTip(tipsByMarket.get(id));
      if (tip && (!best || tip.roi > best.roi)) best = tip;
    }
    return best;
  }, [tipsByMarket, marketIds]);
}
