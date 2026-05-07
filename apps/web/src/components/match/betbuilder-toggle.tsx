"use client";

// Match-page BetBuilder toggle. Per Oddin docs §3.2 the operator may
// either auto-switch when a user picks two same-match selections OR
// expose a manual toggle; we use the manual toggle. When ON, the bet
// slip enters `mode: "betbuilder"` for THIS match and accepts multiple
// legs from it. The slip rail then re-quotes Oddin's OBB SessionCreate
// on every leg change and shows the combined session odds.
//
// Rendered as a compact pill (same dimensions as ScopeTab) inline with
// the scope-tabs row in LiveMarkets. The probe lives in a hook so
// LiveMarkets can suppress the entire row when neither scope tabs nor
// the pill have anything to show — keeps the empty-row case from
// stealing 18px of vertical space.
//
// Visibility gate (hide when ANY of these is true so the pill never
// surfaces an option the user can't use):
//   - sport not in OBB doc Appendix #1 (CS2 / CS2 Duels / Valorant /
//     eFootball / eBasketball)
//   - /betbuilder/match/:id/markets returned 503 (env unset) or 404
//   - probe succeeded but Oddin's marketIds list is empty (live CS2 /
//     Valorant matches are prematch-only per the doc, so they show up
//     here as 200-with-zero-eligible).

import { useEffect, useRef, useState } from "react";
import type { BetBuilderAvailableMarketsResponse } from "@oddzilla/types";
import { useBetSlip } from "@/lib/bet-slip";
import { clientApi, ApiFetchError } from "@/lib/api-client";

const SUPPORTED_SLUGS = new Set([
  "cs2",
  "csgo",
  "counter-strike-2",
  "counter-strike-2-duels",
  "valorant",
  "efootball",
  "ebasketball",
]);

interface ProbeState {
  available: boolean;
  // Cached so the first toggle-on doesn't need to re-fetch.
  eligibleMarketIds: string[] | null;
}

/**
 * Probe `/betbuilder/match/:id/markets` once on mount. Returns whether
 * the toggle should render plus the eligible market id list (used to
 * gate outcome buttons until the user picks the first leg). Hides the
 * toggle when the sport isn't OBB-eligible per Appendix #1, when the
 * api 503s `betbuilder_disabled`, or when Oddin returned an empty list
 * (e.g. a live CS2 match — OBB for CS2 is prematch-only).
 */
export function useBetBuilderProbe(
  matchId: string,
  sportSlug: string,
): ProbeState {
  const [state, setState] = useState<ProbeState>({
    available: false,
    eligibleMarketIds: null,
  });
  const supported = SUPPORTED_SLUGS.has(sportSlug.toLowerCase());

  useEffect(() => {
    if (!supported) {
      setState({ available: false, eligibleMarketIds: null });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await clientApi<BetBuilderAvailableMarketsResponse>(
          `/betbuilder/match/${matchId}/markets`,
        );
        if (cancelled) return;
        if (res.marketIds.length === 0) {
          setState({ available: false, eligibleMarketIds: null });
          return;
        }
        setState({ available: true, eligibleMarketIds: res.marketIds });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiFetchError) {
          setState({ available: false, eligibleMarketIds: null });
        } else {
          setState({ available: false, eligibleMarketIds: null });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [matchId, supported]);

  return state;
}

interface PillProps {
  matchId: string;
  eligibleMarketIds: string[];
}

/**
 * Compact toggle pill — same dimensions as the ScopeTab in
 * live-markets.tsx so the row stays single-line. Caller is
 * responsible for the visibility gate (via useBetBuilderProbe).
 */
export function BetBuilderTogglePill({ matchId, eligibleMarketIds }: PillProps) {
  const slip = useBetSlip();
  const isOn =
    slip.mode === "betbuilder" && slip.betbuilderMatchId === matchId;

  // If the user activated the toggle BEFORE the probe resolved, the
  // slip will have a null eligibility list — push the cached list as
  // soon as we render the pill (probe is by definition resolved here).
  // Held in a ref so the effect only fires when the cached list or
  // the on-state truly changes.
  const lastPushedRef = useRef<string[] | null>(null);
  useEffect(() => {
    if (!isOn) {
      lastPushedRef.current = null;
      return;
    }
    if (lastPushedRef.current === eligibleMarketIds) return;
    slip.setBetbuilderEligibleMarkets(matchId, eligibleMarketIds);
    lastPushedRef.current = eligibleMarketIds;
  }, [isOn, matchId, eligibleMarketIds, slip]);

  function onToggle() {
    if (isOn) {
      slip.setBetbuilderMatch(null);
    } else {
      slip.setBetbuilderMatch(matchId);
      slip.setBetbuilderEligibleMarkets(matchId, eligibleMarketIds);
    }
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isOn}
      onClick={onToggle}
      title={
        isOn
          ? "Turn BetBuilder off — same-match combos disabled"
          : "Turn BetBuilder on — combine multiple selections from this match"
      }
      style={{
        height: 28,
        padding: "0 12px",
        borderRadius: 999,
        border: "1px solid var(--border)",
        background: isOn ? "var(--fg)" : "var(--surface-1)",
        color: isOn ? "var(--bg)" : "var(--fg-muted)",
        fontSize: 12,
        fontWeight: 500,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: "inherit",
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-block",
          width: 6,
          height: 6,
          borderRadius: 999,
          background: isOn ? "var(--positive)" : "var(--fg-dim)",
        }}
      />
      BetBuilder
    </button>
  );
}
