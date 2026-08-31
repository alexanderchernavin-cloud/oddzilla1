"use client";

// useCustomBoostedOdds — syncs the Custom Boosted Odds RULES for one
// match (migration 0085; outcome-scope selections 0087-0088). Prices
// are NOT fetched here: the match page computes boosted prices
// client-side with the shared quoteMarketBoost over the live outcome set
// it already tracks via WS ticks, so a boosted price moves in the exact
// same render as the raw odds — no polling lag on the price path.
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
  /** Market-scope rules, keyed by marketId. */
  byMarket: Map<string, CustomBoostRule>;
  /**
   * Outcome-scope rules — `marketId` -> `outcomeId` -> rule. A market
   * present here is priced by its SELECTION boosts alone: neither its
   * market-scope rule nor `matchWide` applies to it (composing them
   * would take the book past fair — see quoteMarketBoost).
   */
  selectionsByMarket: Map<string, Map<string, CustomBoostRule>>;
  /**
   * Cascade-resolved match-wide rule (match / team / tournament /
   * sport scope) — applies to EVERY market the page renders, including
   * ladder lines created after the last poll. Null = none.
   */
  matchWide: CustomBoostRule | null;
  /**
   * Set only when `matchWide` is a `team_only` team boost (migration
   * 0093): the outcome id that IS the boosted team on this match. The
   * caller must then apply matchWide as a SELECTION on that outcome and
   * ONLY where isTeamShapedMarket(providerMarketId) holds — applying it
   * market-wide would move the opponent's price too.
   */
  matchWideTeamOutcomeId: "1" | "2" | null;
  /** Server-corrected ms-since-epoch for the countdown chips. */
  nowMs: number;
}

const EMPTY: CustomBoostRulesSnapshot = {
  byMarket: new Map(),
  selectionsByMarket: new Map(),
  matchWide: null,
  matchWideTeamOutcomeId: null,
  nowMs: 0,
};

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
  const hasTimed =
    (data?.entries ?? []).some((e) => e.endsAt !== null) ||
    (data?.selections ?? []).some((e) => e.endsAt !== null) ||
    (data?.matchWide?.endsAt ?? null) !== null;
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
    if (
      !data ||
      (data.entries.length === 0 &&
        (data.selections ?? []).length === 0 &&
        !data.matchWide)
    ) {
      return EMPTY;
    }
    const nowMs = Date.now() + skewMs.current;
    // Client-side expiry guard between polls — once endsAt passes,
    // drop the rule immediately instead of waiting for the next
    // fetch (placement would 400 boosted_odds_rule_expired anyway).
    const fresh = (endsAt: string | null) =>
      endsAt === null || new Date(endsAt).getTime() > nowMs;
    const byMarket = new Map<string, CustomBoostRule>();
    for (const e of data.entries) {
      if (!fresh(e.endsAt)) continue;
      byMarket.set(e.marketId, {
        ruleId: e.ruleId,
        boostPct: e.boostPct,
        endsAt: e.endsAt,
      });
    }
    const selectionsByMarket = new Map<string, Map<string, CustomBoostRule>>();
    for (const e of data.selections ?? []) {
      if (!fresh(e.endsAt)) continue;
      let cells = selectionsByMarket.get(e.marketId);
      if (!cells) {
        cells = new Map();
        selectionsByMarket.set(e.marketId, cells);
      }
      cells.set(e.outcomeId, {
        ruleId: e.ruleId,
        boostPct: e.boostPct,
        endsAt: e.endsAt,
      });
    }
    const matchWide =
      data.matchWide && fresh(data.matchWide.endsAt)
        ? {
            ruleId: data.matchWide.ruleId,
            boostPct: data.matchWide.boostPct,
            endsAt: data.matchWide.endsAt,
          }
        : null;
    // Only meaningful while the rule it describes is live.
    const matchWideTeamOutcomeId = matchWide
      ? (data.matchWide?.teamOutcomeId ?? null)
      : null;
    return {
      byMarket,
      selectionsByMarket,
      matchWide,
      matchWideTeamOutcomeId,
      nowMs,
    };
  }, [data, tick]);
}

/**
 * Remaining time for the boost chip, ZillaFlash-style: whenever the
 * rule carries an end time the countdown is shown — "m:ss" under an
 * hour (ticking every second), "Xh Ym" above it. Null only when the
 * boost has no end time (open-ended — no timer) or already expired.
 */
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
  if (remaining >= 3600) {
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    return `${h}h ${m.toString().padStart(2, "0")}m`;
  }
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
