"use client";

// ZillaBoost promo banners on the home page (migration 0086).
// Operator-curated boost rules with banner=true render per scope:
//
//   tournament -> a wide ZillaBoost banner; clicking opens the
//                 tournament's match list (/sport/:slug?tournament=N)
//   match      -> a match card shaped like the match list row (no
//                 score) with original + boosted match-winner prices;
//                 prices click into the slip, the card opens the match
//   market     -> a ZillaFlash-style offer card: market label + every
//                 outcome at crossed-out original + green boosted
//
// Sport-scope banners don't render here — they light the bolt icon in
// the sidebar (see shell/sidebar.tsx). Countdown chips appear only on
// rules with an end time, ZillaFlash-style.

import type { MouseEvent } from "react";
import Link from "next/link";
import { useBetSlip } from "@/lib/bet-slip";
import {
  useZillaBoostBanners,
} from "@/lib/use-zillaboost-banners";
import { formatBoostRemaining } from "@/lib/use-boosted-odds";
import { useTranslations } from "@/lib/i18n";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { LiveDot, TeamMark } from "@/components/ui/primitives";
import type {
  ZillaBoostBannerOutcome,
  ZillaBoostMarketBanner,
  ZillaBoostMatchBanner,
  ZillaBoostTournamentBanner,
} from "@oddzilla/types";

const GREEN = "var(--positive, #16a34a)";

export function ZillaBoostBanners() {
  const snap = useZillaBoostBanners();
  const t = useTranslations("zillaboost");
  if (!snap.loaded) return null;
  const total =
    snap.tournaments.length + snap.matches.length + snap.markets.length;
  if (total === 0) return null;

  return (
    <section aria-label="ZillaBoost" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: GREEN,
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
            ZillaBoost
          </span>
        </div>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: "var(--fg-muted)" }}>
          {t("subtitle")}
        </span>
      </header>

      {snap.tournaments.map((b) => (
        <TournamentBanner key={b.ruleId} banner={b} nowMs={snap.nowMs} />
      ))}

      {(snap.matches.length > 0 || snap.markets.length > 0) && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 10,
          }}
        >
          {snap.matches.map((b) => (
            <MatchBannerCard key={b.ruleId} banner={b} nowMs={snap.nowMs} />
          ))}
          {snap.markets.map((b) => (
            <MarketBannerCard key={b.ruleId} banner={b} nowMs={snap.nowMs} />
          ))}
        </div>
      )}
    </section>
  );
}

// ── Shared chip ─────────────────────────────────────────────────────────

function BoostTag({
  endsAt,
  nowMs,
}: {
  endsAt: string | null;
  nowMs: number;
}) {
  const remaining = formatBoostRemaining({ endsAt }, nowMs);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "1px 7px",
        borderRadius: 5,
        background: GREEN,
        color: "#fff",
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        lineHeight: 1.4,
        flexShrink: 0,
      }}
    >
      <span>ZillaBoost</span>
      {remaining !== null && (
        <span className="mono tnum" style={{ letterSpacing: 0 }}>
          {remaining}
        </span>
      )}
    </span>
  );
}

// ── Tournament banner ───────────────────────────────────────────────────

function TournamentBanner({
  banner: b,
  nowMs,
}: {
  banner: ZillaBoostTournamentBanner;
  nowMs: number;
}) {
  const t = useTranslations("zillaboost");
  const accent = b.brandColor || undefined;
  return (
    <Link
      href={`/sport/${b.sportSlug}?tournament=${b.tournamentId}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "14px 16px",
        borderRadius: "var(--r-md)",
        border: `1px solid ${accent ?? "var(--border)"}`,
        background: accent
          ? `color-mix(in oklab, ${accent} 8%, var(--surface))`
          : `color-mix(in oklab, ${GREEN} 6%, var(--surface))`,
        textDecoration: "none",
        color: "var(--fg)",
      }}
    >
      {b.logoUrl ? (
        // Tournament logo with silent fallback — same convention the
        // sidebar tournament sub-tree uses.
        <img
          src={b.logoUrl}
          alt=""
          width={28}
          height={28}
          style={{ objectFit: "contain", flexShrink: 0 }}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <SportGlyph sport={b.sportSlug} size={22} />
      )}
      <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <BoostTag endsAt={b.endsAt} nowMs={nowMs} />
          <span
            className="mono tnum"
            style={{ fontSize: 11, fontWeight: 700, color: GREEN }}
          >
            +{b.boostPct}%
          </span>
        </span>
        <span
          style={{
            fontSize: 16,
            fontWeight: 650,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {b.name}
        </span>
        <span style={{ fontSize: 11.5, color: "var(--fg-muted)" }}>
          {t("matchesCount", { count: b.matchCount })}
        </span>
      </span>
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--fg)",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          flexShrink: 0,
        }}
      >
        {t("openTournament")}
        <span aria-hidden style={{ color: "var(--fg-dim)" }}>→</span>
      </span>
    </Link>
  );
}

// ── Match banner card ───────────────────────────────────────────────────

function MatchBannerCard({
  banner: b,
  nowMs,
}: {
  banner: ZillaBoostMatchBanner;
  nowMs: number;
}) {
  const slip = useBetSlip();
  const t = useTranslations("zillaboost");
  const live = b.status === "live";

  const pick = (o: ZillaBoostBannerOutcome, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!b.marketId) return;
    slip.clear();
    slip.setMode("single");
    slip.add({
      matchId: b.matchId,
      marketId: b.marketId,
      outcomeId: o.outcomeId,
      odds: o.boostedOdds,
      homeTeam: b.homeTeam,
      awayTeam: b.awayTeam,
      marketLabel: "Match winner",
      outcomeLabel: o.label,
      sportSlug: b.sportSlug,
      active: true,
      customBoostRuleId: b.ruleId,
    });
    slip.setOpen(true);
  };

  const rowFor = (team: "home" | "away") => {
    const name = team === "home" ? b.homeTeam : b.awayTeam;
    const logo = team === "home" ? b.homeLogoUrl : b.awayLogoUrl;
    const outcome = b.outcomes.find(
      (o) => o.outcomeId === (team === "home" ? "1" : "2"),
    );
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <TeamMark tag={name.slice(0, 2).toUpperCase()} name={name} logoUrl={logo} size={20} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13.5,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </span>
        {outcome && (
          <button
            type="button"
            onClick={(e) => pick(outcome, e)}
            style={{
              display: "inline-flex",
              alignItems: "baseline",
              gap: 6,
              padding: "3px 8px",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              cursor: "pointer",
              fontFamily: "inherit",
              flexShrink: 0,
            }}
          >
            <span
              className="mono tnum"
              style={{
                fontSize: 10.5,
                color: "var(--fg-dim)",
                textDecoration: "line-through",
              }}
            >
              {o(outcome).original}
            </span>
            <span
              className="mono tnum"
              style={{ fontSize: 13, fontWeight: 700, color: GREEN }}
            >
              {o(outcome).boosted}
            </span>
          </button>
        )}
      </div>
    );
  };

  return (
    <Link
      href={`/match/${b.matchId}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 7,
        padding: "10px 12px",
        background: "var(--surface)",
        border: `1px solid color-mix(in oklab, ${GREEN} 40%, var(--border))`,
        borderRadius: "var(--r-md)",
        textDecoration: "none",
        color: "var(--fg)",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <SportGlyph sport={b.sportSlug} size={13} />
        <span
          className="mono"
          style={{
            fontSize: 10,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "var(--fg-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            flex: 1,
          }}
          title={b.tournamentName}
        >
          {b.tournamentName}
          {b.bestOf ? ` · BO${b.bestOf}` : ""}
        </span>
        {live ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: 10.5,
              fontWeight: 700,
              color: "var(--live, #dc2626)",
              flexShrink: 0,
            }}
          >
            <LiveDot size={6} /> LIVE
          </span>
        ) : (
          b.scheduledAt && (
            <span
              className="mono tnum"
              style={{ fontSize: 10.5, color: "var(--fg-muted)", flexShrink: 0 }}
            >
              {new Date(b.scheduledAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )
        )}
        <BoostTag endsAt={b.endsAt} nowMs={nowMs} />
      </div>
      {rowFor("home")}
      {rowFor("away")}
      {b.outcomes.length === 0 && (
        <span style={{ fontSize: 11.5, color: "var(--fg-muted)" }}>
          {t("openMatchForPrices")}
        </span>
      )}
    </Link>
  );
}

// Original/boosted accessor — keeps the JSX above terse.
function o(entry: ZillaBoostBannerOutcome): { original: string; boosted: string } {
  return { original: entry.originalOdds, boosted: entry.boostedOdds };
}

// ── Market banner card (ZillaFlash-style) ───────────────────────────────

function MarketBannerCard({
  banner: b,
  nowMs,
}: {
  banner: ZillaBoostMarketBanner;
  nowMs: number;
}) {
  const slip = useBetSlip();
  const t = useTranslations("zillaboost");

  const pick = (entry: ZillaBoostBannerOutcome) => {
    slip.clear();
    slip.setMode("single");
    slip.add({
      matchId: b.matchId,
      marketId: b.marketId,
      outcomeId: entry.outcomeId,
      odds: entry.boostedOdds,
      homeTeam: b.homeTeam,
      awayTeam: b.awayTeam,
      marketLabel: b.marketLabel,
      outcomeLabel: entry.label,
      sportSlug: b.sportSlug,
      active: true,
      customBoostRuleId: b.ruleId,
    });
    slip.setOpen(true);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 5,
        padding: "10px 12px",
        background: "var(--surface)",
        border: `1px solid color-mix(in oklab, ${GREEN} 40%, var(--border))`,
        borderRadius: "var(--r-md)",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SportGlyph sport={b.sportSlug} size={13} />
        <BoostTag endsAt={b.endsAt} nowMs={nowMs} />
        <span style={{ flex: 1 }} />
        <Link
          href={`/match/${b.matchId}`}
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
      <span style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>
        {b.homeTeam} · {b.awayTeam}
      </span>
      <span style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.3 }}>
        {b.marketLabel}
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 2 }}>
        {b.outcomes.map((entry) => (
          <button
            key={entry.outcomeId}
            type="button"
            onClick={() => pick(entry)}
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
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 13,
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={entry.label}
            >
              {entry.label}
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
              className="mono tnum"
              style={{
                fontSize: 13.5,
                fontWeight: 700,
                color: GREEN,
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
        ))}
      </div>
    </div>
  );
}
