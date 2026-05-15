"use client";

// Lobby ZillaFlash row. Renders the 4 active boosted offers (2 prematch
// + 2 live) as a compact grid with a countdown chip above each card.
// Click adds the boosted leg to the bet slip, frozen at the boosted
// price; the server re-validates the offer id + boosted odds before
// debiting stake so a stale click 400s and the slip refreshes.
//
// Cards render even when the underlying odds move between polls — the
// boostedOdds string is regenerated server-side every 2 s and the card
// flashes via useOddsFlash on every price tick.

import type { CSSProperties } from "react";
import { useRef } from "react";
import Link from "next/link";
import { useBetSlip } from "@/lib/bet-slip";
import { useOddsFlash } from "@/lib/use-odds-flash";
import {
  formatRemaining,
  useZillaFlash,
  type ZillaFlashOffer,
} from "@/lib/use-zillaflash";
import { useTranslations } from "@/lib/i18n";
import { SportGlyph } from "@/components/ui/sport-glyph";

export function ZillaFlashRow() {
  const snapshot = useZillaFlash();
  const t = useTranslations("zillaflash");

  if (!snapshot.loaded) return null;
  if (snapshot.prematch.length === 0 && snapshot.live.length === 0) return null;

  // Render order: prematch then live, interleaved deterministically so
  // the grid always reads left→right as prematch | prematch | live | live.
  const offers: ZillaFlashOffer[] = [
    ...snapshot.prematch,
    ...snapshot.live,
  ];

  return (
    <section className="oz-zillaflash-row" aria-label="ZillaFlash">
      <header className="oz-zillaflash-header">
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: "var(--accent, #c2410c)",
            }}
          >
            {t("kicker")}
          </span>
          <span
            style={{
              fontFamily: "var(--font-display, inherit)",
              fontSize: 22,
              fontWeight: 500,
              letterSpacing: "-0.01em",
              color: "var(--fg)",
            }}
          >
            ZillaFlash
          </span>
        </div>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: "var(--fg-muted)" }}>
          {t("subtitle")}
        </span>
      </header>
      <div className="oz-zillaflash-grid">
        {offers.map((offer) => (
          <ZillaFlashCard
            key={offer.id}
            offer={offer}
            nowMs={snapshot.nowMs}
          />
        ))}
      </div>
    </section>
  );
}

function ZillaFlashCard({
  offer,
  nowMs,
}: {
  offer: ZillaFlashOffer;
  nowMs: number;
}) {
  const slip = useBetSlip();
  const t = useTranslations("zillaflash");
  const oddsRef = useRef<HTMLSpanElement | null>(null);
  const boostedNum = Number.parseFloat(offer.boostedOdds);
  useOddsFlash(Number.isFinite(boostedNum) ? boostedNum : null, oddsRef);

  const remaining = formatRemaining(offer, nowMs);
  const remainingMs = Math.max(
    0,
    new Date(offer.expiresAt).getTime() - nowMs,
  );
  // Visual urgency: ≤5 s left turns the countdown red. The colour is a
  // soft alarm — not a button — and uses the site's negative token so
  // it lands in both themes.
  const urgent = remainingMs <= 5_000;

  const handle = () => {
    slip.clear();
    slip.setMode("single");
    slip.add({
      matchId: offer.matchId,
      marketId: offer.marketId,
      outcomeId: offer.outcomeId,
      odds: offer.boostedOdds,
      homeTeam: offer.homeTeam,
      awayTeam: offer.awayTeam,
      marketLabel: offer.marketLabel,
      outcomeLabel: offer.outcomeLabel,
      sportSlug: offer.sportSlug,
      active: true,
      zillaFlashOfferId: offer.id,
    });
    slip.setOpen(true);
  };

  const cardStyle: CSSProperties = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--r-md)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  };

  return (
    <div className="oz-zillaflash-card" style={cardStyle}>
      <div
        className="oz-zillaflash-countdown"
        data-urgent={urgent ? "true" : "false"}
        title={offer.kind === "live" ? t("kindLive") : t("kindPrematch")}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: offer.kind === "live" ? "#ef4444" : "var(--accent, #c2410c)",
          }}
        />
        <span className="mono tnum" style={{ letterSpacing: "0.04em" }}>
          {remaining}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "var(--fg-dim)",
          }}
        >
          {offer.kind === "live" ? t("kindLive") : t("kindPrematch")}
        </span>
      </div>
      <button
        type="button"
        onClick={handle}
        aria-label={t("aria", {
          team: offer.outcomeLabel,
          market: offer.marketLabel,
          odds: offer.boostedOdds,
        })}
        style={{
          background: "transparent",
          border: 0,
          borderTop: "1px solid var(--hairline)",
          padding: "10px 12px 12px",
          textAlign: "left",
          cursor: "pointer",
          color: "var(--fg)",
          fontFamily: "inherit",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11.5,
            color: "var(--fg-muted)",
            minWidth: 0,
          }}
        >
          <SportGlyph sport={offer.sportSlug} size={13} />
          <span
            style={{
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0,
              flex: 1,
            }}
            title={`${offer.homeTeam} vs ${offer.awayTeam}`}
          >
            {offer.homeTeam} · {offer.awayTeam}
          </span>
          <Link
            href={`/match/${offer.matchId}`}
            onClick={(e) => e.stopPropagation()}
            style={{
              color: "var(--fg-dim)",
              fontSize: 11,
              textDecoration: "none",
              border: "1px solid var(--hairline)",
              borderRadius: 4,
              padding: "1px 6px",
              flexShrink: 0,
            }}
          >
            →
          </Link>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            minWidth: 0,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <span
              style={{
                fontWeight: 600,
                fontSize: 13.5,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0,
              }}
              title={offer.outcomeLabel}
            >
              {offer.outcomeLabel}
            </span>
            <span
              style={{
                fontSize: 11,
                color: "var(--fg-muted)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0,
              }}
              title={offer.marketLabel}
            >
              {offer.marketLabel}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              flexShrink: 0,
            }}
          >
            <span
              className="mono tnum"
              style={{
                fontSize: 11.5,
                color: "var(--fg-dim)",
                textDecoration: "line-through",
              }}
            >
              {offer.originalOdds}
            </span>
            <span
              ref={oddsRef}
              className="mono tnum"
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: "var(--positive, #16a34a)",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "4px 10px",
              }}
            >
              {offer.boostedOdds}
            </span>
          </div>
        </div>
      </button>
    </div>
  );
}
