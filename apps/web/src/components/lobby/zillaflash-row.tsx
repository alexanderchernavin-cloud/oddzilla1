"use client";

// Lobby ZillaFlash row. Renders the 4 active boosted offers (2 prematch
// + 2 live) as a grid with a top-edge progress bar per card. The bar
// shrinks from full width to zero as the offer's TTL elapses and
// transitions colour green → amber → red across the run. Click adds
// the boosted leg to the bet slip; the server re-validates the offer
// id + boosted odds before debiting stake so a stale click 400s and
// the slip refreshes.
//
// Cards stay populated even when the underlying odds move between
// polls — the boostedOdds string is regenerated server-side every 2 s
// and the price chip flashes via useOddsFlash on every tick.

import type { CSSProperties } from "react";
import { useRef } from "react";
import Link from "next/link";
import { useBetSlip } from "@/lib/bet-slip";
import { useOddsFlash } from "@/lib/use-odds-flash";
import {
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

  // Render order: prematch first, then live — so the grid reads left
  // → right as prematch | prematch | live | live on desktop.
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

// ProgressBar: a 4-px-tall track across the top edge of the card. The
// fill width = (remaining / total) × 100% and the colour transitions
// in two steps: green while > 2/3 remains, amber for the middle
// third, red for the final third. CSS transitions absorb the
// quarter-second tick from the parent so the bar appears to flow
// smoothly rather than step.
function ProgressBar({
  offer,
  nowMs,
}: {
  offer: ZillaFlashOffer;
  nowMs: number;
}) {
  const startMs = new Date(offer.startedAt).getTime();
  const expiresMs = new Date(offer.expiresAt).getTime();
  const totalMs = Math.max(1, expiresMs - startMs);
  const remainingMs = Math.max(0, expiresMs - nowMs);
  const pct = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));

  // Three-step colour ramp. Tracking the rest of the site's positive /
  // accent / negative tokens keeps the bar themed; the rgba alpha on
  // the track makes the unfilled portion read as a faded gutter
  // rather than empty card space.
  const color =
    pct > 66
      ? "var(--positive, #16a34a)"
      : pct > 33
        ? "#d97706"
        : "var(--negative, #b91c1c)";

  return (
    <div
      aria-hidden
      style={{
        position: "relative",
        height: 4,
        background: "var(--hairline)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: "0 auto 0 0",
          width: `${pct}%`,
          background: color,
          // Smooth visually across the 250 ms tick from the hook —
          // ease-out is gentler than linear when the bar nears zero.
          transition: "width 240ms linear, background-color 240ms linear",
        }}
      />
    </div>
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
      <ProgressBar offer={offer} nowMs={nowMs} />
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
          padding: "10px 12px 12px",
          textAlign: "left",
          cursor: "pointer",
          color: "var(--fg)",
          fontFamily: "inherit",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
          }}
        >
          <SportGlyph sport={offer.sportSlug} size={13} />
          <span
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "var(--fg-dim)",
              flexShrink: 0,
            }}
          >
            {offer.kind === "live" ? t("kindLive") : t("kindPrematch")}
          </span>
          <span style={{ flex: 1 }} />
          <Link
            href={`/match/${offer.matchId}`}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Open ${offer.homeTeam} vs ${offer.awayTeam}`}
            style={{
              color: "var(--fg-dim)",
              fontSize: 11,
              textDecoration: "none",
              border: "1px solid var(--hairline)",
              borderRadius: 4,
              padding: "1px 6px",
              flexShrink: 0,
              lineHeight: 1.1,
            }}
          >
            →
          </Link>
        </div>

        {/* Teams. Wrap allowed so a long pair like "Natus Vincere ·
            Team Vitality" stays whole on narrow cards instead of
            clipping mid-name. */}
        <span
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: "var(--fg)",
            lineHeight: 1.25,
            wordBreak: "break-word",
          }}
        >
          {offer.homeTeam} · {offer.awayTeam}
        </span>

        {/* Selection: must always render in full (per design ask).
            wordBreak handles long Cyrillic team names; whiteSpace
            stays default so spaces wrap naturally. */}
        <span
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: "var(--fg)",
            lineHeight: 1.3,
            wordBreak: "break-word",
          }}
        >
          {offer.outcomeLabel}
        </span>

        {/* Market name: same wrap rules. The translated market
            description (e.g. "Total rounds parity - map 1") can be
            long; we let it spill onto two lines rather than clip. */}
        <span
          style={{
            fontSize: 11.5,
            color: "var(--fg-muted)",
            lineHeight: 1.3,
            wordBreak: "break-word",
          }}
        >
          {offer.marketLabel}
        </span>

        {/* Price row. The boosted odds dominate visually; the
            crossed-out original sits at a quieter weight on the
            left so the discount reads at a glance. */}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 10,
            marginTop: 2,
          }}
        >
          <span
            className="mono tnum"
            style={{
              fontSize: 12,
              color: "var(--fg-dim)",
              textDecoration: "line-through",
            }}
          >
            {offer.originalOdds}
          </span>
          <span style={{ flex: 1 }} />
          <span
            ref={oddsRef}
            className="mono tnum"
            style={{
              fontSize: 17,
              fontWeight: 700,
              color: "var(--positive, #16a34a)",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "4px 12px",
            }}
          >
            {offer.boostedOdds}
          </span>
        </div>
      </button>
    </div>
  );
}
