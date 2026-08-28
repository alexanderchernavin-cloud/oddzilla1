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

import { useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
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
  ZillaBoostSportBanner,
  ZillaBoostTournamentBanner,
} from "@oddzilla/types";

const GREEN = "var(--positive, #16a34a)";

// A banner price that's currently in the slip wears the same accent fill
// a match-row OddButton does, so a pick made from the lobby reads as
// picked in the place it was made — without it the click looked like it
// did nothing even though the slip had filled in.
//
// The green boost treatment steps aside while selected (same rule
// OddButton follows): "it's in your slip" is the more important signal,
// and the green price is unreadable on the accent fill.
function pickedStyle(selected: boolean): CSSProperties {
  return selected
    ? {
        background: "var(--accent)",
        borderColor: "var(--accent)",
        color: "var(--accent-fg)",
      }
    : {
        background: "var(--surface-2)",
        borderColor: "var(--border)",
        color: "var(--fg)",
      };
}

/** Struck-through pre-boost price colour, per selected state. */
function strikeColor(selected: boolean): string {
  return selected
    ? "color-mix(in oklab, var(--accent-fg) 60%, transparent)"
    : "var(--fg-dim)";
}

/** Boosted price colour, per selected state. */
function boostedColor(selected: boolean): string {
  return selected ? "var(--accent-fg)" : GREEN;
}

export function ZillaBoostBanners() {
  const snap = useZillaBoostBanners();
  const t = useTranslations("zillaboost");
  if (!snap.loaded) return null;
  // Sport banners count toward the section being worth rendering. They
  // used to be excluded (sport scope only lit the sidebar bolt), so a
  // sport-wide boost with "create promo banner" ticked rendered nothing
  // at all here.
  const total =
    snap.sports.length +
    snap.tournaments.length +
    snap.matches.length +
    snap.markets.length;
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

      {snap.sports.map((b) => (
        <SportBanner key={b.ruleId} banner={b} nowMs={snap.nowMs} />
      ))}

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

// ── AI banner art (migration 0089) ──────────────────────────────────────

/**
 * Full-bleed background graphic for the wide (sport / tournament)
 * banners. The image sits behind a left-to-right scrim so the text keeps
 * contrast whatever the picture is; the content column above it flips to
 * light-on-dark. onError unmounts the layer so a broken image degrades
 * to the plain banner rather than a broken-image glyph.
 */
function BannerArtBackdrop({
  url,
  onFail,
}: {
  url: string;
  onFail: () => void;
}) {
  return (
    <>
      <img
        src={url}
        alt=""
        onError={onFail}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          zIndex: 0,
        }}
      />
      <span
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 1,
          background:
            "linear-gradient(90deg, rgba(10, 14, 12, 0.82) 0%, rgba(10, 14, 12, 0.55) 55%, rgba(10, 14, 12, 0.25) 100%)",
        }}
      />
    </>
  );
}

/** Top image strip for the card-shaped (match / market) banners. */
function BannerArtStrip({ url, onFail }: { url: string; onFail: () => void }) {
  return (
    <img
      src={url}
      alt=""
      onError={onFail}
      style={{
        width: "calc(100% + 24px)",
        margin: "-10px -12px 0",
        aspectRatio: "3 / 1",
        objectFit: "cover",
        borderRadius: "var(--r-md) var(--r-md) 0 0",
        display: "block",
      }}
    />
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

// ── Sport banner ────────────────────────────────────────────────────────
// A sport-wide boost covers every market of every match under the sport,
// so there is no single price to quote — the banner is a signpost into
// the sport's match list, where each card carries its own boosted odds.
// Same shape as the tournament banner for the same reason.

function SportBanner({
  banner: b,
  nowMs,
}: {
  banner: ZillaBoostSportBanner;
  nowMs: number;
}) {
  const t = useTranslations("zillaboost");
  const [artFailed, setArtFailed] = useState(false);
  const art = !artFailed && b.imageUrl ? b.imageUrl : null;
  const accent = b.brandColor || undefined;
  return (
    <Link
      href={`/sport/${b.slug}`}
      style={{
        position: "relative",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: art ? "18px 16px" : "14px 16px",
        borderRadius: "var(--r-md)",
        border: `1px solid ${accent ?? "var(--border)"}`,
        background: accent
          ? `color-mix(in oklab, ${accent} 8%, var(--surface))`
          : `color-mix(in oklab, ${GREEN} 6%, var(--surface))`,
        textDecoration: "none",
        // Over the AI art + scrim the content is always light-on-dark,
        // whatever the theme.
        color: art ? "#fff" : "var(--fg)",
      }}
    >
      {art && <BannerArtBackdrop url={art} onFail={() => setArtFailed(true)} />}
      {/* SportGlyph already resolves the admin-uploaded logo, the
          bundled SVG, and the initials fallback in that order, so it
          covers b.logoUrl without a second <img> chain. */}
      <span style={{ position: "relative", zIndex: 2, display: "inline-flex", flexShrink: 0 }}>
        <SportGlyph sport={b.slug} size={26} />
      </span>
      <span
        style={{
          position: "relative",
          zIndex: 2,
          display: "flex",
          flexDirection: "column",
          gap: 3,
          minWidth: 0,
          flex: 1,
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <BoostTag endsAt={b.endsAt} nowMs={nowMs} />
          <span
            className="mono tnum"
            style={{
              fontSize: 11,
              fontWeight: 700,
              // The brand green vanishes into dark art — over the scrim
              // the pct rides a lighter tint of it.
              color: art ? "#7ee2a0" : GREEN,
            }}
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
        <span
          style={{
            fontSize: 11.5,
            color: art ? "rgba(255, 255, 255, 0.75)" : "var(--fg-muted)",
          }}
        >
          {t("matchesCount", { count: b.matchCount })}
        </span>
      </span>
      <span
        style={{
          position: "relative",
          zIndex: 2,
          fontSize: 12,
          fontWeight: 600,
          color: art ? "#fff" : "var(--fg)",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          flexShrink: 0,
        }}
      >
        {t("openSport")}
        <span
          aria-hidden
          style={{ color: art ? "rgba(255, 255, 255, 0.7)" : "var(--fg-dim)" }}
        >
          →
        </span>
      </span>
    </Link>
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
  const [artFailed, setArtFailed] = useState(false);
  const art = !artFailed && b.imageUrl ? b.imageUrl : null;
  const accent = b.brandColor || undefined;
  return (
    <Link
      href={`/sport/${b.sportSlug}?tournament=${b.tournamentId}`}
      style={{
        position: "relative",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: art ? "18px 16px" : "14px 16px",
        borderRadius: "var(--r-md)",
        border: `1px solid ${accent ?? "var(--border)"}`,
        background: accent
          ? `color-mix(in oklab, ${accent} 8%, var(--surface))`
          : `color-mix(in oklab, ${GREEN} 6%, var(--surface))`,
        textDecoration: "none",
        color: art ? "#fff" : "var(--fg)",
      }}
    >
      {art && <BannerArtBackdrop url={art} onFail={() => setArtFailed(true)} />}
      <span style={{ position: "relative", zIndex: 2, display: "inline-flex", flexShrink: 0 }}>
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
      </span>
      <span
        style={{
          position: "relative",
          zIndex: 2,
          display: "flex",
          flexDirection: "column",
          gap: 3,
          minWidth: 0,
          flex: 1,
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <BoostTag endsAt={b.endsAt} nowMs={nowMs} />
          <span
            className="mono tnum"
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: art ? "#7ee2a0" : GREEN,
            }}
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
        <span
          style={{
            fontSize: 11.5,
            color: art ? "rgba(255, 255, 255, 0.75)" : "var(--fg-muted)",
          }}
        >
          {t("matchesCount", { count: b.matchCount })}
        </span>
      </span>
      <span
        style={{
          position: "relative",
          zIndex: 2,
          fontSize: 12,
          fontWeight: 600,
          color: art ? "#fff" : "var(--fg)",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          flexShrink: 0,
        }}
      >
        {t("openTournament")}
        <span
          aria-hidden
          style={{ color: art ? "rgba(255, 255, 255, 0.7)" : "var(--fg-dim)" }}
        >
          →
        </span>
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
  const [artFailed, setArtFailed] = useState(false);
  const art = !artFailed && b.imageUrl ? b.imageUrl : null;
  const live = b.status === "live";

  // Is this cell the one currently in the slip?
  const isPicked = (o: ZillaBoostBannerOutcome) =>
    b.marketId != null && slip.has(b.marketId, o.outcomeId);

  const pick = (o: ZillaBoostBannerOutcome, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!b.marketId) return;
    // Clicking the pick that's already in the slip takes it back out,
    // matching a match-row odd button. Without the toggle the only way
    // to undo a banner pick was the slip's own remove control.
    if (slip.has(b.marketId, o.outcomeId)) {
      slip.remove(b.marketId, o.outcomeId);
      return;
    }
    slip.clear();
    slip.setMode("single");
    slip.add({
      matchId: b.matchId,
      marketId: b.marketId,
      outcomeId: o.outcomeId,
      odds: o.boostedOdds,
      homeTeam: b.homeTeam,
      awayTeam: b.awayTeam,
      marketLabel: b.marketLabel ?? "Match winner",
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
    const outcome = b.teamShaped
      ? b.outcomes.find((o) => o.outcomeId === (team === "home" ? "1" : "2"))
      : undefined;
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
            aria-pressed={isPicked(outcome)}
            style={{
              display: "inline-flex",
              alignItems: "baseline",
              gap: 6,
              padding: "3px 8px",
              border: "1px solid",
              borderRadius: 8,
              cursor: "pointer",
              fontFamily: "inherit",
              flexShrink: 0,
              transition: "all 140ms var(--ease)",
              ...pickedStyle(isPicked(outcome)),
            }}
          >
            <span
              className="mono tnum"
              style={{
                fontSize: 10.5,
                color: strikeColor(isPicked(outcome)),
                textDecoration: "line-through",
              }}
            >
              {o(outcome).original}
            </span>
            <span
              className="mono tnum"
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: boostedColor(isPicked(outcome)),
              }}
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
        overflow: "hidden",
      }}
    >
      {art && <BannerArtStrip url={art} onFail={() => setArtFailed(true)} />}
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
      {!b.teamShaped && b.outcomes.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            borderTop: "1px solid var(--hairline)",
            paddingTop: 6,
          }}
        >
          <span
            style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.2 }}
          >
            {b.marketLabel}
          </span>
          {b.outcomes.map((entry) => {
            const picked = isPicked(entry);
            return (
            <button
              key={entry.outcomeId}
              type="button"
              onClick={(e) => pick(entry, e)}
              aria-pressed={picked}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 0,
                padding: "3px 6px 3px 8px",
                border: "1px solid",
                borderRadius: 8,
                cursor: "pointer",
                fontFamily: "inherit",
                textAlign: "left",
                transition: "all 140ms var(--ease)",
                ...pickedStyle(picked),
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12.5,
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
                  fontSize: 10.5,
                  color: strikeColor(picked),
                  textDecoration: "line-through",
                  flexShrink: 0,
                }}
              >
                {entry.originalOdds}
              </span>
              <span
                className="mono tnum"
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: boostedColor(picked),
                  flexShrink: 0,
                }}
              >
                {entry.boostedOdds}
              </span>
            </button>
            );
          })}
        </div>
      )}
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
  const [artFailed, setArtFailed] = useState(false);
  const art = !artFailed && b.imageUrl ? b.imageUrl : null;

  const isPicked = (entry: ZillaBoostBannerOutcome) =>
    slip.has(b.marketId, entry.outcomeId);

  const pick = (entry: ZillaBoostBannerOutcome) => {
    // Re-clicking the picked cell removes it, same as a match-row odd.
    if (slip.has(b.marketId, entry.outcomeId)) {
      slip.remove(b.marketId, entry.outcomeId);
      return;
    }
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
        overflow: "hidden",
      }}
    >
      {art && <BannerArtStrip url={art} onFail={() => setArtFailed(true)} />}
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
        {b.outcomes.map((entry) => {
          const picked = isPicked(entry);
          return (
          <button
            key={entry.outcomeId}
            type="button"
            onClick={() => pick(entry)}
            aria-pressed={picked}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minWidth: 0,
              padding: "4px 6px 4px 8px",
              border: "1px solid",
              borderRadius: 8,
              cursor: "pointer",
              fontFamily: "inherit",
              textAlign: "left",
              transition: "all 140ms var(--ease)",
              ...pickedStyle(picked),
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
                color: strikeColor(picked),
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
                color: boostedColor(picked),
                // The inset price chip reads as a raised tile on an
                // unpicked row; on the accent fill it would look like a
                // hole punched in the button, so it goes flat instead.
                background: picked ? "transparent" : "var(--bg)",
                border: `1px solid ${picked ? "transparent" : "var(--border)"}`,
                borderRadius: 6,
                padding: "2px 8px",
                flexShrink: 0,
              }}
            >
              {entry.boostedOdds}
            </span>
          </button>
          );
        })}
      </div>
    </div>
  );
}
