"use client";

// ZillaFacts — statistical fact band between the live stream and the
// markets-tabs strip on the match-detail page. Each card states one
// fact in plain English (server-composed `factText`) and exposes the
// linked outcome's live odds as a clickable button that adds the
// selection to the bet slip — same `add()` path the OddButton inside
// the markets tree uses. Cards never rotate; the API caps at
// ZILLAFACT_MAX_CARDS and surfaces them in a deterministic score-
// sorted order, so once a card is on the page it stays put.
//
// For live matches the API switches the fact source from "team's
// last N matches on this market" to "team's last N matches in the
// SAME in-match state as the current scoreboard" — e.g. after the
// team has just won Map 1, the band can flip to "After winning Map
// 1, Aurora have closed out the match in their last 6 starts" with
// Match Winner Aurora attached. The frontend doesn't need to know
// which path produced the fact; both ship `factText` + a target
// market+outcome and the card renders identically.
//
// Layout grid lives in globals.css (.oz-zillafacts-grid): 3 columns
// at ≥1100px (including 4K with the right rail visible), 2 at
// 720-1099px, 1 below. Cards stretch to the column, so chip-row
// removal also drops the previous per-card minWidth/maxWidth.

import { useMemo } from "react";
import {
  zillaFactTier,
  type ZillaFact,
} from "@oddzilla/types/zillafacts";
import { useZillaFacts } from "@/lib/use-zillafacts";
import { useBetSlip } from "@/lib/bet-slip";
import { TeamMark } from "@/components/ui/primitives";
import { I } from "@/components/ui/icons";

// 2-3 letter abbreviation derived from a team's display name. Same
// algorithm ZillaTips uses for its leg chips — kept local so the
// fact card doesn't depend on widget internals.
function teamTag(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0]![0]! + words[1]![0]!).toUpperCase();
  }
  return (words[0] ?? name).slice(0, 3).toUpperCase();
}

// Tier-specific chrome for the streak badge (top-right of the card)
// AND a subtle accent ring around the card itself. Token-aware so
// the look stays coherent against both themes; the gradient
// backgrounds match the ZillaTips badge palette so the two widgets
// feel like one family.
function tierChrome(tier: ReturnType<typeof zillaFactTier>) {
  if (tier === "fire") {
    return {
      badgeBg: "linear-gradient(135deg, rgba(255, 90, 30, 0.95), rgba(255, 50, 60, 0.95))",
      badgeColor: "#fff",
      badgeBorder: "1px solid rgba(255, 90, 30, 0.7)",
      badgeShadow: "0 0 12px rgba(255, 90, 30, 0.45)",
      cardRing: "0 0 0 1px rgba(255, 90, 30, 0.3)",
      cardAccent: "linear-gradient(180deg, rgba(255, 90, 30, 0.18), rgba(255, 90, 30, 0))",
      icon: <I.Fire size={12} />,
      label: "FIRE",
    };
  }
  if (tier === "glow") {
    return {
      badgeBg: "linear-gradient(135deg, rgba(255, 150, 50, 0.95), rgba(255, 110, 30, 0.95))",
      badgeColor: "#fff",
      badgeBorder: "1px solid rgba(255, 150, 50, 0.7)",
      badgeShadow: "0 0 8px rgba(255, 150, 50, 0.3)",
      cardRing: "0 0 0 1px rgba(255, 150, 50, 0.28)",
      cardAccent: "linear-gradient(180deg, rgba(255, 150, 50, 0.14), rgba(255, 150, 50, 0))",
      icon: <I.Fire size={12} />,
      label: "HOT",
    };
  }
  return {
    badgeBg: "var(--accent, #f0e9d8)",
    badgeColor: "var(--accent-fg, #1c1a14)",
    badgeBorder: "1px solid var(--accent-border, rgba(0, 0, 0, 0.12))",
    badgeShadow: "none",
    cardRing: "0 0 0 1px var(--border)",
    cardAccent: "none",
    icon: <I.Sparkles size={12} />,
    label: "FACT",
  };
}

// One card. The card itself is a static container (not an anchor)
// so the only interactive surface is the odds pill — clicking it
// toggles the selection on the bet slip via the same add()/remove()
// pair the market grid uses.
function FactCard({
  fact,
  matchId,
  homeTeam,
  awayTeam,
  sportSlug,
}: {
  fact: ZillaFact;
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  sportSlug: string;
}) {
  const slip = useBetSlip();
  const tier = zillaFactTier(fact.score);
  const chrome = tierChrome(tier);
  const oddsLabel = fact.currentOdds ?? "—";
  const selected = slip.has(fact.marketId, fact.outcomeId);
  const oddsClickable = fact.currentOdds != null;

  const onOddsClick = () => {
    if (!oddsClickable) return;
    if (selected) {
      slip.remove(fact.marketId, fact.outcomeId);
      return;
    }
    slip.add({
      matchId,
      marketId: fact.marketId,
      outcomeId: fact.outcomeId,
      odds: fact.currentOdds!,
      active: true,
      homeTeam,
      awayTeam,
      marketLabel: fact.marketName,
      outcomeLabel: fact.outcomeLabel,
      sportSlug,
    });
  };

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
        borderRadius: "var(--r-md)",
        background: "var(--bg-elevated)",
        boxShadow: chrome.cardRing,
        overflow: "hidden",
        isolation: "isolate",
        minWidth: 0,
      }}
    >
      {chrome.cardAccent !== "none" && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            background: chrome.cardAccent,
            pointerEvents: "none",
            zIndex: 0,
          }}
        />
      )}

      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--fg-dim)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          {fact.streak} in a row
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            height: 18,
            padding: "0 7px",
            borderRadius: 999,
            background: chrome.badgeBg,
            color: chrome.badgeColor,
            border: chrome.badgeBorder,
            boxShadow: chrome.badgeShadow,
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
          }}
        >
          {chrome.icon}
          <span className="mono">{chrome.label}</span>
        </span>
      </div>

      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          gap: 10,
          minWidth: 0,
        }}
      >
        <TeamMark
          tag={teamTag(fact.teamName)}
          name={fact.teamName}
          size={28}
          logoUrl={fact.teamLogoUrl}
          color={fact.teamBrandColor ?? undefined}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1.2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {fact.teamName}
          </span>
        </div>
      </div>

      {/* Plain-English fact sentence — server-composed so it reads
          identically for streak facts ("Aurora won their last 5
          matches") and live-conditioned facts ("After winning Map 1,
          Aurora have closed out the match in their last 5 starts").
          Two lines max via line-clamp; longer wording wraps clean. */}
      <p
        style={{
          position: "relative",
          zIndex: 1,
          margin: 0,
          fontSize: 13,
          lineHeight: 1.4,
          color: "var(--fg)",
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {fact.factText}
      </p>

      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "8px 10px",
          borderRadius: "var(--r-sm)",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            flex: "1 1 auto",
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: 9.5,
              color: "var(--fg-dim)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {fact.marketName}
          </span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              lineHeight: 1.25,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {fact.outcomeLabel}
          </span>
        </div>
        <button
          type="button"
          onClick={onOddsClick}
          disabled={!oddsClickable}
          aria-label={
            selected
              ? `Remove ${fact.outcomeLabel} from bet slip`
              : `Add ${fact.outcomeLabel} at ${oddsLabel} to bet slip`
          }
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            font: "inherit",
            fontSize: 16,
            fontFamily: "var(--font-mono)",
            fontVariantNumeric: "tabular-nums",
            fontWeight: 700,
            color: selected ? "var(--accent-fg)" : "var(--accent-fg, var(--fg))",
            background: selected ? "var(--accent)" : "var(--accent, #f0e9d8)",
            padding: "6px 12px",
            borderRadius: "var(--r-sm)",
            border: selected
              ? "1px solid var(--accent)"
              : "1px solid var(--accent, transparent)",
            cursor: oddsClickable ? "pointer" : "not-allowed",
            opacity: oddsClickable ? 1 : 0.55,
            transition:
              "transform 120ms var(--ease), background 140ms var(--ease)",
            flexShrink: 0,
          }}
        >
          {oddsLabel}
        </button>
      </div>
    </div>
  );
}

// Public widget mounted on the match-detail page. Fetches on mount
// (one round-trip — server caches for 5 min), then renders a fluid
// grid of cards. Returns null while loading OR when no fact
// qualifies, so the band collapses to zero height without flicker.
export function ZillaFactsCards({
  matchId,
  homeTeam,
  awayTeam,
  sportSlug,
}: {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  sportSlug: string;
}) {
  const { facts, loaded } = useZillaFacts(matchId);
  // Defensive cap mirrors the server's ZILLAFACT_MAX_CARDS so a
  // future v-bump that ships more rows doesn't accidentally overflow
  // the band; the slice is a no-op against today's payload.
  const visible = useMemo(() => facts.slice(0, 6), [facts]);
  if (!loaded || visible.length === 0) return null;

  return (
    <section
      aria-label="ZillaFacts — historical streaks on this match"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--fg-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.12em",
          }}
        >
          ZillaFacts
        </span>
        <span
          className="mono"
          style={{
            fontSize: 10,
            color: "var(--fg-dim)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          streaks worth knowing
        </span>
      </div>
      <div className="oz-zillafacts-grid">
        {visible.map((fact) => (
          <FactCard
            key={`${fact.marketId}:${fact.outcomeId}:${fact.teamId}`}
            fact={fact}
            matchId={matchId}
            homeTeam={homeTeam}
            awayTeam={awayTeam}
            sportSlug={sportSlug}
          />
        ))}
      </div>
    </section>
  );
}
