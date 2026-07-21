"use client";

// ZillaBuild — pre-built BetBuilder combos surfaced as cards on the
// PREMATCH match page, between the ZillaFacts band and the markets tree.
// Each card is a ready-made single-map combo (2-4 legs). "Use this build"
// loads the card into the bet slip's existing BetBuilder mode, where the
// rail re-quotes Oddin and the user sets a stake + places — same path the
// manual BetBuilder toggle uses, so there's no bespoke placement code.
//
// Composition is chosen once and persisted server-side; the odds shown
// here are re-quoted from Oddin on every page open. Returns null while
// loading OR when there are no cards (the feature is off, BetBuilder isn't
// available for the match, or no valid combo could be built), so the band
// collapses to zero height.

import { useMemo } from "react";
import type { ZillaBuildCard, ZillaBuildResponse } from "@oddzilla/types/zillabuild";
import { useZillaBuild } from "@/lib/use-zillabuild";
import { useBetSlip } from "@/lib/bet-slip";
import { I } from "@/components/ui/icons";
import { useTranslations } from "@/lib/i18n";

export function ZillaBuildCards({
  matchId,
  homeTeam,
  awayTeam,
  sportSlug,
  initialStatus,
}: {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  sportSlug: string;
  // Prematch-only. The server also gates on not_started, but skipping the
  // fetch entirely for live/closed matches avoids a pointless round-trip.
  initialStatus: "not_started" | "live" | "closed" | "cancelled" | "suspended";
}) {
  const t = useTranslations("matchWidgets");
  const tMatch = useTranslations("match");
  const enabled = initialStatus === "not_started";
  const { response, loaded } = useZillaBuild(enabled ? matchId : "");

  // Group cards by map, preserving the server's (map, slot) sort.
  const byMap = useMemo(() => groupByMap(response), [response]);

  if (!enabled || !loaded || !response || response.cards.length === 0) {
    return null;
  }

  return (
    <section
      aria-label={t("zillabuild.aria")}
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--fg-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.12em",
          }}
        >
          ZillaBuild
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
          {t("zillabuild.tagline")}
        </span>
      </div>

      {byMap.map(({ mapNumber, cards }) => (
        <div key={mapNumber} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: "var(--fg-dim)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            {tMatch("mapTab", { n: mapNumber })}
          </span>
          <div className="oz-zillabuild-grid">
            {cards.map((card) => (
              <BuildCard
                key={card.id}
                card={card}
                matchId={matchId}
                homeTeam={homeTeam}
                awayTeam={awayTeam}
                sportSlug={sportSlug}
                eligibleMarketIds={response.eligibleMarketIds}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function groupByMap(
  response: ZillaBuildResponse | null,
): Array<{ mapNumber: number; cards: ZillaBuildCard[] }> {
  if (!response) return [];
  const groups = new Map<number, ZillaBuildCard[]>();
  for (const card of response.cards) {
    const list = groups.get(card.mapNumber) ?? [];
    list.push(card);
    groups.set(card.mapNumber, list);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([mapNumber, cards]) => ({ mapNumber, cards }));
}

function BuildCard({
  card,
  matchId,
  homeTeam,
  awayTeam,
  sportSlug,
  eligibleMarketIds,
}: {
  card: ZillaBuildCard;
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  sportSlug: string;
  eligibleMarketIds: string[];
}) {
  const t = useTranslations("matchWidgets");
  const tSlip = useTranslations("betSlip");
  const slip = useBetSlip();

  // This exact build is "on the slip" when the slip is in BetBuilder mode
  // for this match and carries precisely the card's legs.
  const onSlip =
    slip.mode === "betbuilder" &&
    slip.betbuilderMatchId === matchId &&
    slip.selections.length === card.legs.length &&
    card.legs.every((l) => slip.has(l.marketId, l.outcomeId));

  const useBuild = () => {
    // Reset the slip, then enter BetBuilder for this match and add every
    // leg. clear() drops any prior builder/combo state; the subsequent
    // functional updates compose in order so the slip ends up holding
    // exactly this card's legs in BetBuilder mode. The rail then re-quotes
    // /betbuilder/match/:id/quote against the leg set.
    slip.clear();
    slip.setBetbuilderMatch(matchId);
    slip.setBetbuilderEligibleMarkets(matchId, eligibleMarketIds);
    for (const leg of card.legs) {
      slip.add({
        matchId,
        marketId: leg.marketId,
        outcomeId: leg.outcomeId,
        odds: leg.odds,
        active: true,
        homeTeam,
        awayTeam,
        marketLabel: leg.marketLabel,
        outcomeLabel: leg.outcomeLabel,
        sportSlug,
      });
    }
    slip.setOpen(true);
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
        boxShadow: "0 0 0 1px var(--border)",
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            height: 18,
            padding: "0 7px",
            borderRadius: 999,
            background: "var(--accent, #f0e9d8)",
            color: "var(--accent-fg, #1c1a14)",
            border: "1px solid var(--accent-border, rgba(0,0,0,0.12))",
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
          }}
        >
          <I.Ticket size={11} />
          <span className="mono">
            {tSlip("legs", { count: card.legs.length })}
          </span>
        </span>
        <span
          className="mono tnum"
          style={{ fontSize: 15, fontWeight: 700, color: "var(--fg)" }}
          title={t("zillabuild.combinedOdds")}
        >
          {card.combinedOdds}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {card.legs.map((leg) => (
          <div
            key={`${leg.marketId}:${leg.outcomeId}`}
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 8,
              minWidth: 0,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span
                className="mono"
                style={{
                  fontSize: 9.5,
                  color: "var(--fg-dim)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {leg.marketLabel}
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
                {leg.outcomeLabel}
              </span>
            </div>
            <span
              className="mono tnum"
              style={{ fontSize: 12, color: "var(--fg-muted)", flexShrink: 0 }}
            >
              {leg.odds}
            </span>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={useBuild}
        disabled={onSlip}
        aria-label={onSlip ? t("zillabuild.buildOnSlip") : t("zillabuild.useBuild")}
        style={{
          width: "100%",
          height: 36,
          borderRadius: "var(--r-sm)",
          border: onSlip
            ? "1px solid var(--border)"
            : "1px solid var(--accent, #f0e9d8)",
          background: onSlip ? "var(--surface-2)" : "var(--accent, #f0e9d8)",
          color: onSlip ? "var(--fg-muted)" : "var(--accent-fg, #1c1a14)",
          fontFamily: "inherit",
          fontSize: 13,
          fontWeight: 600,
          cursor: onSlip ? "default" : "pointer",
          transition: "background 140ms var(--ease)",
        }}
      >
        {onSlip ? t("onBetSlip") : t("zillabuild.useBuild")}
      </button>
    </div>
  );
}
