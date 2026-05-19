"use client";

// Lobby ZillaFlash row. Renders the 4 active boosted offers (2 prematch
// + 2 live) as a grid with a top-edge progress bar per card. The bar
// shrinks from full width to zero as the offer's TTL elapses and
// transitions colour green → amber → red across the run.
//
// Each card lists EVERY outcome on the boosted market with its own
// crossed-out original + green boosted price; clicking any row adds
// THAT outcome to the slip with the matching boost. The server
// re-validates the offer id + boosted odds before debiting stake
// so a stale click 400s and the slip refreshes.

import type { CSSProperties, MouseEvent } from "react";
import { useMemo, useRef } from "react";
import Link from "next/link";
import { useBetSlip } from "@/lib/bet-slip";
import { useOddsFlash } from "@/lib/use-odds-flash";
import {
  useZillaFlash,
  type ZillaFlashOffer,
} from "@/lib/use-zillaflash";
import { useTranslations } from "@/lib/i18n";
import { SportGlyph } from "@/components/ui/sport-glyph";

// Lobby home renders everything; the dedicated /live + /upcoming
// listing pages pass a kind filter so only the relevant offers show.
// "all" mounts both kinds side-by-side in prematch-first order.
export function ZillaFlashRow({
  kind = "all",
}: {
  kind?: "prematch" | "live" | "all";
} = {}) {
  const snapshot = useZillaFlash();
  const t = useTranslations("zillaflash");

  if (!snapshot.loaded) return null;

  // Pick the slice the caller asked for. Both lists are short (≤2 each)
  // so filtering is free; the engine doesn't expose a kind-specific
  // endpoint because polling one is the same cost as polling both and
  // hits the same cache.
  const offers: ZillaFlashOffer[] = (() => {
    if (kind === "live") return snapshot.live;
    if (kind === "prematch") return snapshot.prematch;
    return [...snapshot.prematch, ...snapshot.live];
  })();
  if (offers.length === 0) return null;

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

  // Sort outcomes for display. Three-way markets render 1 / X / 2
  // (home / draw / away) — Oddin assigns outcome id "3" to the draw,
  // so it slots between "1" and "2" via weight 1.5. Mirrors the
  // catalog-side ordering applied by outcomeSortWeight() in
  // services/api/src/lib/market-naming.ts. Non-canonical outcome
  // ids (URNs, "over"/"under", …) fall back to ascending boosted
  // odds so favourites lead.
  const outcomes = useMemo(() => {
    const weight = (id: string): number | null => {
      const n = Number.parseInt(id, 10);
      if (!Number.isFinite(n) || String(n) !== id) return null;
      if (n === 3) return 1.5;
      return n;
    };
    return [...offer.marketSnapshot].sort((a, b) => {
      const aw = weight(a.outcomeId);
      const bw = weight(b.outcomeId);
      if (aw != null && bw != null) return aw - bw;
      if (aw != null) return -1;
      if (bw != null) return 1;
      const ao = Number.parseFloat(a.boostedOdds);
      const bo = Number.parseFloat(b.boostedOdds);
      if (!Number.isFinite(ao)) return 1;
      if (!Number.isFinite(bo)) return -1;
      return ao - bo;
    });
  }, [offer.marketSnapshot]);

  const handleOutcome = (entry: ZillaFlashOffer["marketSnapshot"][number]) => {
    slip.clear();
    slip.setMode("single");
    slip.add({
      matchId: offer.matchId,
      marketId: offer.marketId,
      outcomeId: entry.outcomeId,
      odds: entry.boostedOdds,
      homeTeam: offer.homeTeam,
      awayTeam: offer.awayTeam,
      marketLabel: offer.marketLabel,
      outcomeLabel: entry.outcomeLabel,
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
      <div
        style={{
          padding: "8px 10px 10px",
          color: "var(--fg)",
          display: "flex",
          flexDirection: "column",
          gap: 5,
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
            aria-label={t("openMatch")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              height: 22,
              padding: "0 10px",
              color: "var(--fg)",
              fontSize: 11,
              fontWeight: 500,
              textDecoration: "none",
              border: "1px solid var(--border)",
              background: "var(--surface-2)",
              borderRadius: 999,
              flexShrink: 0,
              lineHeight: 1,
              whiteSpace: "nowrap",
            }}
          >
            {t("openMatch")}
            <span aria-hidden style={{ color: "var(--fg-dim)" }}>→</span>
          </Link>
        </div>

        {/* Fixture identity */}
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--fg)",
            lineHeight: 1.3,
            wordBreak: "break-word",
          }}
        >
          {offer.homeTeam} · {offer.awayTeam}
        </span>

        {/* Market name */}
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

        {/* Every outcome on the market — each is its own clickable row.
            Picking any row adds that exact outcome to the slip with
            its boosted price. Rows pre-sorted by boosted odds asc so
            favourites lead. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            marginTop: 2,
            minWidth: 0,
          }}
        >
          {outcomes.map((o) => (
            <OutcomeRow
              key={o.outcomeId}
              entry={o}
              onPick={(e) => {
                e.preventDefault();
                handleOutcome(o);
              }}
              ariaLabel={t("aria", {
                team: o.outcomeLabel,
                market: offer.marketLabel,
                odds: o.boostedOdds,
              })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function OutcomeRow({
  entry,
  onPick,
  ariaLabel,
}: {
  entry: ZillaFlashOffer["marketSnapshot"][number];
  onPick: (e: MouseEvent<HTMLButtonElement>) => void;
  ariaLabel: string;
}) {
  const oddsRef = useRef<HTMLSpanElement | null>(null);
  const boostedNum = Number.parseFloat(entry.boostedOdds);
  useOddsFlash(Number.isFinite(boostedNum) ? boostedNum : null, oddsRef);
  return (
    <button
      type="button"
      onClick={onPick}
      aria-label={ariaLabel}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        minWidth: 0,
        padding: "4px 6px 4px 8px",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        cursor: "pointer",
        color: "var(--fg)",
        fontFamily: "inherit",
        textAlign: "left",
        transition: "border-color 140ms var(--ease), background 140ms var(--ease)",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor =
          "var(--positive, #16a34a)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.borderColor =
          "var(--border)";
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          fontWeight: 600,
          color: "var(--fg)",
          lineHeight: 1.2,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={entry.outcomeLabel}
      >
        {entry.outcomeLabel}
      </span>
      <span
        className="mono tnum"
        style={{
          fontSize: 11.5,
          color: "var(--fg-dim)",
          textDecoration: "line-through",
          flexShrink: 0,
        }}
      >
        {entry.originalOdds}
      </span>
      <span
        ref={oddsRef}
        className="mono tnum"
        style={{
          fontSize: 13.5,
          fontWeight: 700,
          color: "var(--positive, #16a34a)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "2px 8px",
          flexShrink: 0,
        }}
      >
        {entry.boostedOdds}
      </span>
    </button>
  );
}
