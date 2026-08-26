"use client";

// useCustomBoostedOdds — syncs the Custom Boosted Odds RULES for one
// match (migration 0085). Prices are NOT fetched here: the match page
// computes boosted prices client-side with the shared boostMarketKey
// over the live outcome set it already tracks via WS ticks, so a
// boosted price moves in the exact same render as the raw odds — no
// polling lag on the price path.
//
// The poll below only propagates ADMIN rule changes (create / edit /
// delete) and the per-viewer Min Risk Score gate, both of which change
// on human timescales. 5 s keeps config propagation snappy without
// price freshness depending on it.
//
// The optional per-rule endsAt drives a countdown chip; rules without
// one render the plain BOOST chip (no timer). A 1 s tick runs only
// while some rule actually has an end time.

import { useEffect, useMemo, useRef, useState } from "react";
import { clientApi } from "./api-client";
import type { CustomBoostedOddsResponse } from "@oddzilla/types";

const POLL_INTERVAL_MS = 5_000;
const TICK_INTERVAL_MS = 1_000;

/** The rule applying to one market, as resolved by the server per viewer. */
export interface CustomBoostRule {
  ruleId: string;
  boostPct: number;
  /** ISO end time or null = no countdown. */
  endsAt: string | null;
}

/**
 * One boosted outcome cell — built by the match page from a
 * CustomBoostRule + the live outcome set (see live-markets.tsx).
 */
export interface CustomBoostEntry {
  ruleId: string;
  marketId: string;
  boostPct: number;
  endsAt: string | null;
  originalOdds: string;
  boostedOdds: string;
}

export interface CustomBoostRulesSnapshot {
  /** Keyed by marketId. Empty map = no boosts for this viewer. */
  byMarket: Map<string, CustomBoostRule>;
  /** Server-corrected ms-since-epoch for the countdown chips. */
  nowMs: number;
}

const EMPTY: CustomBoostRulesSnapshot = { byMarket: new Map(), nowMs: 0 };

export function useCustomBoostedOdds(matchId: string): CustomBoostRulesSnapshot {
  const [data, setData] = useState<CustomBoostedOddsResponse | null>(null);
  const skewMs = useRef(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Reset on match navigation so the previous match's rules don't
    // apply to the new page while the first fetch is in flight.
    setData(null);

    const fetchOnce = async () => {
      try {
        const res = await clientApi<CustomBoostedOddsResponse>(
          `/catalog/matches/${matchId}/boosted-odds`,
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
  }, [matchId]);

  // Countdown re-render tick — only when a rule actually expires.
  const hasTimed = (data?.entries ?? []).some((e) => e.endsAt !== null);
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
    if (!data || data.entries.length === 0) return EMPTY;
    const nowMs = Date.now() + skewMs.current;
    const byMarket = new Map<string, CustomBoostRule>();
    for (const e of data.entries) {
      // Client-side expiry guard between polls — once endsAt passes,
      // drop the rule immediately instead of waiting for the next
      // fetch (placement would 400 boosted_odds_rule_expired anyway).
      if (e.endsAt !== null && new Date(e.endsAt).getTime() <= nowMs) continue;
      byMarket.set(e.marketId, {
        ruleId: e.ruleId,
        boostPct: e.boostPct,
        endsAt: e.endsAt,
      });
    }
    return { byMarket, nowMs };
  }, [data, tick]);
}

/** "0:08"-style remaining time, or null when the entry has no end time. */
export function formatBoostRemaining(
  entry: Pick<CustomBoostEntry, "endsAt">,
  nowMs: number,
): string | null {
  if (entry.endsAt === null) return null;
  const remaining = Math.max(
    0,
    Math.ceil((new Date(entry.endsAt).getTime() - nowMs) / 1000),
  );
  if (remaining <= 0) return null;
  // Beyond an hour a mm:ss countdown is noise — show the plain chip.
  if (remaining > 3600) return null;
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
