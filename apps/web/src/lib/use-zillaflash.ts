"use client";

// useZillaFlash — client-side hook that polls /catalog/zillaflash every
// 2 s for the latest 4 boosted offers (2 prematch + 2 live). The hook
// returns the current snapshot plus a `nowMs` clock that ticks every
// 250 ms so the per-offer countdown chip re-renders without re-fetching.
//
// Live offers turn over every 15 s, prematch every 60 s — so the
// underlying boost odds may move between polls (when the broker
// updates the published odds). The 2 s cadence is fast enough to feel
// "live" without hammering the api: a single home-page viewer is ~30
// requests/min, well below any sensible rate-limit floor.
//
// Server time is included in the payload (`serverNow`); we use it to
// correct for browser clock skew so the countdown reads "00:14" on
// every machine regardless of system clock drift.
//
// usePerMatchZillaFlash variant filters the same response down to one
// match — used by the match page to overlay a ZillaFlash chip on the
// matching market button without a second API.

import { useEffect, useMemo, useRef, useState } from "react";
import { clientApi } from "./api-client";
import type {
  ZillaFlashKind,
  ZillaFlashOffer,
  ZillaFlashResponse,
} from "@oddzilla/types";

const POLL_INTERVAL_MS = 2_000;
const TICK_INTERVAL_MS = 250;

export interface ZillaFlashSnapshot {
  prematch: ZillaFlashOffer[];
  live: ZillaFlashOffer[];
  /** Server-corrected milliseconds-since-epoch used by countdowns. */
  nowMs: number;
  /** Has the first fetch resolved (true) or are we pre-mount (false). */
  loaded: boolean;
}

const EMPTY: ZillaFlashSnapshot = {
  prematch: [],
  live: [],
  nowMs: 0,
  loaded: false,
};

export function useZillaFlash(): ZillaFlashSnapshot {
  const [data, setData] = useState<ZillaFlashResponse | null>(null);
  // skewMs = (server now) - (local now) at the moment of the last poll.
  // Used so the countdown matches the server's expiresAt without the
  // user's wall-clock skew throwing it off.
  const skewMs = useRef(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchOnce = async () => {
      try {
        const res = await clientApi<ZillaFlashResponse>("/catalog/zillaflash");
        if (cancelled) return;
        if (res.prematch.length > 0) {
          const srv = new Date(res.prematch[0]!.serverNow).getTime();
          skewMs.current = srv - Date.now();
        } else if (res.live.length > 0) {
          const srv = new Date(res.live[0]!.serverNow).getTime();
          skewMs.current = srv - Date.now();
        }
        setData(res);
      } catch {
        // Network blip — just try again next interval. Don't clear data.
      } finally {
        if (!cancelled) {
          timer = setTimeout(fetchOnce, POLL_INTERVAL_MS);
        }
      }
    };

    void fetchOnce();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), TICK_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);
  void tick; // referenced only for re-render side-effect

  return useMemo(() => {
    if (!data) return EMPTY;
    return {
      prematch: data.prematch,
      live: data.live,
      nowMs: Date.now() + skewMs.current,
      loaded: true,
    };
  }, [data, tick]);
}

// Filter the same snapshot to offers for a specific match. Used by the
// match-detail page so we don't make a second API call.
export function offersForMatch(
  snapshot: ZillaFlashSnapshot,
  matchId: string,
): ZillaFlashOffer[] {
  const out: ZillaFlashOffer[] = [];
  for (const o of snapshot.prematch) if (o.matchId === matchId) out.push(o);
  for (const o of snapshot.live) if (o.matchId === matchId) out.push(o);
  return out;
}

// Boost entry for a specific outcome of a market. Backs the match-page
// per-outcome cell highlight: each cell needs the offer's id +
// countdown (from `offer`) AND its own boosted/original odds (from
// the marketSnapshot row for THAT outcomeId). The pre-restructure
// version of this map keyed by the offer's "chosen" outcomeId alone
// — now every outcome in the market gets an entry so all selections
// of a boosted market render with the discount.
export interface OutcomeBoostEntry {
  offer: ZillaFlashOffer;
  outcomeLabel: string;
  originalOdds: string;
  boostedOdds: string;
}

// Build a per-(marketId, outcomeId) lookup covering EVERY outcome on
// each boosted market. The match page renders the BOOST chip + cell
// highlight on every entry; click-handlers carry the offer id +
// per-outcome boosted price into the slip.
export function indexOffers(
  offers: readonly ZillaFlashOffer[],
): Map<string, OutcomeBoostEntry> {
  const map = new Map<string, OutcomeBoostEntry>();
  for (const o of offers) {
    for (const snap of o.marketSnapshot) {
      map.set(`${o.marketId}:${snap.outcomeId}`, {
        offer: o,
        outcomeLabel: snap.outcomeLabel,
        originalOdds: snap.originalOdds,
        boostedOdds: snap.boostedOdds,
      });
    }
  }
  return map;
}

// Format the remaining seconds for a countdown chip. Returns "0:08",
// or "—" once expired.
export function formatRemaining(offer: ZillaFlashOffer, nowMs: number): string {
  const expires = new Date(offer.expiresAt).getTime();
  const remaining = Math.max(0, Math.ceil((expires - nowMs) / 1000));
  if (remaining <= 0) return "—";
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export type { ZillaFlashKind, ZillaFlashOffer };
