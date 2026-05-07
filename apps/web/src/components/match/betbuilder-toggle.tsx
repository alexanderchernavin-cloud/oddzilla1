"use client";

// Match-page BetBuilder toggle. Per Oddin docs §3.2 the operator may
// either auto-switch when a user picks two same-match selections OR
// expose a manual toggle; we use the manual toggle. When ON, the bet
// slip enters `mode: "betbuilder"` for THIS match and accepts multiple
// legs from it. The slip rail then re-quotes Oddin's OBB SessionCreate
// on every leg change and shows the combined session odds.
//
// The toggle silently hides when /betbuilder/match/:id/markets returns
// 503 betbuilder_disabled (env unset) or 404 match_not_found, so on
// non-OBB sports / when Oddin's gRPC channel is offline the user sees
// no broken affordance.

import { useEffect, useRef, useState } from "react";
import type { BetBuilderAvailableMarketsResponse } from "@oddzilla/types";
import { useBetSlip } from "@/lib/bet-slip";
import { clientApi, ApiFetchError } from "@/lib/api-client";

interface Props {
  matchId: string;
  sportSlug: string;
}

// Sports Oddin OBB supports. Mirrors HumanDocs/Oddin.gg BetBuilder
// (OBB) documentation.docx §1.1 Appendix #1 — gates the toggle on the
// match page so we don't paint it on sports the bookmaker can't price
// (e.g. League of Legends, Dota 2).
const SUPPORTED_SLUGS = new Set([
  "cs2",
  "csgo",
  "counter-strike-2",
  "counter-strike-2-duels",
  "valorant",
  "efootball",
  "ebasketball",
]);

export function BetBuilderToggle({ matchId, sportSlug }: Props) {
  const slip = useBetSlip();
  const [serviceState, setServiceState] = useState<
    "loading" | "available" | "unavailable"
  >("loading");
  // Cache the eligible-markets probe response so we can push it into
  // slip state at toggle-on time without a re-fetch. Held in a ref so
  // an async resolution after toggle-on still pushes through.
  const eligibleRef = useRef<string[] | null>(null);

  const supported = SUPPORTED_SLUGS.has(sportSlug.toLowerCase());

  const setBetbuilderEligibleMarkets = slip.setBetbuilderEligibleMarkets;
  const isOn =
    slip.mode === "betbuilder" && slip.betbuilderMatchId === matchId;

  // Probe availability on mount. The /markets endpoint also primes
  // Oddin's per-match cache (1d TTL per their docs §2.7), so the first
  // SessionCreate call after the user toggles ON is fast.
  useEffect(() => {
    if (!supported) {
      setServiceState("unavailable");
      return;
    }
    let cancelled = false;
    eligibleRef.current = null;
    (async () => {
      try {
        const res = await clientApi<BetBuilderAvailableMarketsResponse>(
          `/betbuilder/match/${matchId}/markets`,
        );
        if (cancelled) return;
        eligibleRef.current = res.marketIds;
        setServiceState("available");
        // If builder was already toggled on for this match before the
        // probe resolved, push the eligibility list now so the match
        // page can grey out unreachable outcomes immediately.
        if (isOn) {
          setBetbuilderEligibleMarkets(matchId, res.marketIds);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiFetchError) {
          setServiceState("unavailable");
        } else {
          // Network or unknown — keep loading off, hide toggle.
          setServiceState("unavailable");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [matchId, supported, isOn, setBetbuilderEligibleMarkets]);

  if (serviceState !== "available") return null;

  function onToggle() {
    if (isOn) {
      slip.setBetbuilderMatch(null);
    } else {
      slip.setBetbuilderMatch(matchId);
      // Push the (already-resolved) eligible-markets list so LiveMarkets
      // can gate outcome buttons before the user picks the first leg.
      if (eligibleRef.current) {
        slip.setBetbuilderEligibleMarkets(matchId, eligibleRef.current);
      }
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        background: isOn
          ? "color-mix(in oklab, var(--accent, var(--fg)) 8%, var(--surface))"
          : "var(--surface)",
        border: `1px solid ${
          isOn ? "color-mix(in oklab, var(--accent, var(--fg)) 35%, var(--border))" : "var(--border)"
        }`,
        borderRadius: 10,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--fg-muted)",
            fontWeight: 600,
          }}
        >
          BetBuilder
        </span>
        <span style={{ fontSize: 13, color: "var(--fg)", lineHeight: 1.4 }}>
          {isOn
            ? "Combine multiple selections from this match into one ticket."
            : "Build a same-match combo with one combined price."}
        </span>
      </div>
      <div style={{ flex: 1 }} />
      <button
        type="button"
        role="switch"
        aria-checked={isOn}
        onClick={onToggle}
        style={{
          width: 44,
          height: 24,
          padding: 2,
          borderRadius: 999,
          border: "1px solid var(--border)",
          background: isOn ? "var(--fg)" : "var(--surface-2)",
          cursor: "pointer",
          position: "relative",
          flexShrink: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            display: "block",
            width: 18,
            height: 18,
            borderRadius: 999,
            background: isOn ? "var(--bg)" : "var(--fg-muted)",
            transform: `translateX(${isOn ? 20 : 0}px)`,
            transition: "transform 150ms ease",
          }}
        />
      </button>
    </div>
  );
}
