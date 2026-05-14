"use client";

import Link from "next/link";
import { useRef } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { Pill, LiveDot, TeamMark } from "@/components/ui/primitives";
import { TierMark, isFeaturedTier } from "@/components/ui/tier-mark";
import { useBetSlip } from "@/lib/bet-slip";
import { mapCellValue, type LiveScore } from "@/lib/live-score";
import { useOddsFlash, useValueFlash } from "@/lib/use-odds-flash";
import { useTranslations } from "@/lib/i18n";
import { LocalDateTime } from "./local-datetime";
import type { SlipSelection } from "@oddzilla/types";

export interface ListMatch {
  id: string;
  homeTeam: string;
  awayTeam: string;
  homeLogoUrl?: string | null;
  awayLogoUrl?: string | null;
  scheduledAt: string | null;
  status: "not_started" | "live" | "closed" | "cancelled" | "suspended";
  bestOf?: number | null;
  liveScore?: LiveScore | null;
  tournament: { id: number; name: string; riskTier?: number | null };
  matchWinner: {
    marketId: string;
    home: { outcomeId: string; price: string | null; probability?: string | null };
    away: { outcomeId: string; price: string | null; probability?: string | null };
    // Set when the underlying market is 3-way (BO2 esports, 1X2 sports).
    // The card grows a "Draw" row between home and away when present.
    draw?: { outcomeId: string; price: string | null; probability?: string | null } | null;
  } | null;
}

interface Props {
  match: ListMatch;
  sportSlug: string;
  sportShort: string;
  // Live chat viewer count for this match (Notion Epic 1). Renders a
  // "N watching" pill next to LIVE. Omit / pass 0 to hide.
  viewerCount?: number;
}

export function MatchRow({
  match,
  sportSlug,
  sportShort,
  viewerCount = 0,
}: Props) {
  const slip = useBetSlip();
  const isLive = match.status === "live";
  const tMatch = useTranslations("match");
  const tCommon = useTranslations("common");
  const matchWinnerLabel = tMatch("matchWinner");
  const drawLabel = tCommon("draw");

  function handlePick(
    side: "home" | "away" | "draw",
    e: MouseEvent<HTMLButtonElement>,
  ) {
    e.preventDefault();
    e.stopPropagation();
    if (!match.matchWinner) return;
    const o =
      side === "draw" ? match.matchWinner.draw ?? null : match.matchWinner[side];
    if (!o || !o.price) return;
    const outcomeLabel =
      side === "home"
        ? match.homeTeam
        : side === "away"
          ? match.awayTeam
          : drawLabel;
    const selection: SlipSelection = {
      matchId: match.id,
      marketId: match.matchWinner.marketId,
      outcomeId: o.outcomeId,
      odds: o.price,
      probability: o.probability ?? undefined,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      marketLabel: matchWinnerLabel,
      outcomeLabel,
      sportSlug,
      // Stamped active=true here because the click-handler bails on null
      // price above; mergeMatchWithLive in MatchListTabs already nulls
      // the price when an in-flight WS tick reports active=false, so
      // reaching this code path means the outcome was bettable when the
      // user clicked. The slip rail re-derives active from later ticks.
      active: true,
    };
    if (slip.has(selection.marketId, selection.outcomeId)) {
      slip.remove(selection.marketId, selection.outcomeId);
    } else {
      slip.add(selection);
    }
  }

  const homePicked = match.matchWinner
    ? slip.has(match.matchWinner.marketId, match.matchWinner.home.outcomeId)
    : false;
  const awayPicked = match.matchWinner
    ? slip.has(match.matchWinner.marketId, match.matchWinner.away.outcomeId)
    : false;
  const drawPicked = match.matchWinner?.draw
    ? slip.has(match.matchWinner.marketId, match.matchWinner.draw.outcomeId)
    : false;

  // Date formatting moved to LocalDateTime so the timezone is always
  // the user's browser tz instead of the prod box's UTC. See PR #330
  // for the bug where SSR + client rendering disagreed by 2 hours.
  const showWhen = !isLive && match.scheduledAt != null;

  const homePrice = match.matchWinner?.home.price
    ? Number(match.matchWinner.home.price)
    : null;
  const awayPrice = match.matchWinner?.away.price
    ? Number(match.matchWinner.away.price)
    : null;
  const drawPrice = match.matchWinner?.draw?.price
    ? Number(match.matchWinner.draw.price)
    : null;
  const hasDraw = !!match.matchWinner?.draw;

  const homeOdds = (
    <RowOddBtn
      label="1"
      price={homePrice}
      selected={homePicked}
      locked={!homePrice}
      onClick={(e) => handlePick("home", e)}
    />
  );
  const awayOdds = (
    <RowOddBtn
      label="2"
      price={awayPrice}
      selected={awayPicked}
      locked={!awayPrice}
      onClick={(e) => handlePick("away", e)}
    />
  );
  const drawOdds = hasDraw ? (
    <RowOddBtn
      label="X"
      price={drawPrice}
      selected={drawPicked}
      // Lock the draw button only when its own price is missing —
      // independent of home/away so a suspended draw doesn't pretend
      // the whole market is unavailable.
      locked={!drawPrice}
      onClick={(e) => handlePick("draw", e)}
      // Keep the "X" visible on mobile — without a team name on its
      // row, the label is the only cue this is the draw outcome.
      keepLabelOnMobile
    />
  ) : null;

  const tier = match.tournament.riskTier ?? null;
  const featured = isFeaturedTier(tier);
  // Top-tier cards (Oddin risk_tier 1 or 2) earn a subtle gold left-edge
  // accent so the eye picks them out in a long list. The user wants both
  // tiers treated the same — a single "Top" affordance instead of two
  // ranks of highlight.
  const cardStyle: CSSProperties = {
    borderRadius: "var(--r-md)",
    overflow: "hidden",
    transition: "border-color 160ms var(--ease)",
    cursor: "pointer",
    ...(featured ? { borderLeft: "2px solid var(--tier-gold)" } : null),
  };

  return (
    <Link
      href={`/match/${match.id}`}
      style={{ textDecoration: "none", color: "inherit" }}
    >
      <article className="card" style={cardStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            borderBottom: "1px solid var(--hairline)",
            fontSize: 11.5,
            color: "var(--fg-muted)",
            minWidth: 0,
          }}
        >
          <SportGlyph sport={sportSlug} size={13} />
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--fg-dim)",
              flexShrink: 0,
            }}
          >
            {sportShort}
          </span>
          <span style={{ color: "var(--fg-dim)", flexShrink: 0 }}>·</span>
          {featured && <TierMark tier={tier} size={11} />}
          <span
            style={{
              color: featured ? "var(--fg)" : "var(--fg-muted)",
              fontWeight: featured ? 600 : undefined,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {truncate(match.tournament.name, 32)}
          </span>
          {match.bestOf && (
            <>
              <span style={{ color: "var(--fg-dim)", flexShrink: 0 }}>·</span>
              <span
                className="mono"
                style={{ fontSize: 10.5, color: "var(--fg-dim)", flexShrink: 0 }}
              >
                BO{match.bestOf}
              </span>
            </>
          )}

          <div style={{ flex: 1, minWidth: 4 }} />

          {isLive ? (
            <>
              <Pill tone="live">
                <LiveDot size={6} /> {tCommon("live")}
              </Pill>
              {viewerCount > 0 ? (
                <ViewerCountPill count={viewerCount} />
              ) : null}
            </>
          ) : (
            showWhen && (
              <span
                className="mono"
                style={{ fontSize: 11, color: "var(--fg-muted)", flexShrink: 0 }}
              >
                <LocalDateTime iso={match.scheduledAt} mode="row" />
              </span>
            )
          )}
        </div>

        <ScoreTable
          homeTeam={match.homeTeam}
          awayTeam={match.awayTeam}
          homeLogoUrl={match.homeLogoUrl ?? null}
          awayLogoUrl={match.awayLogoUrl ?? null}
          liveScore={match.liveScore ?? null}
          bestOf={match.bestOf ?? null}
          isLive={isLive}
          sportSlug={sportSlug}
          homeTrailing={homeOdds}
          awayTrailing={awayOdds}
          drawTrailing={drawOdds}
        />
      </article>
    </Link>
  );
}

// Cap the rendered length and append ".." (two dots) when a name is too
// long, per UX preference. CSS ellipsis still kicks in below this length
// when the column itself is narrower than the truncated string — both
// layers together keep mobile rows on one line at any viewport width.
function truncate(name: string, max: number): string {
  if (name.length <= max) return name;
  return name.slice(0, max).trimEnd() + "..";
}

function teamTag(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 3)
    .map((w) => w[0])
    .join("")
    .slice(0, 4);
}

// ScoreTable renders a mini-scoreboard mirroring the match-detail
// page's Scoreboard but in compact form for list cards:
//   [team mark + name] | Σ | Map 1 | Map 2 | Map N | [trailing]
// `homeTrailing` / `awayTrailing` add a per-row trailing cell — used by
// MatchRow to slot the odds button vertically aligned with each team
// row instead of as a separate 2-column block to the right. That gives
// the name column a much wider track on narrow viewports.
//
// When `drawTrailing` is set (3-way match-winner — BO2 series, 1X2
// sports) an extra "Draw" row sits between home and away. The row's
// team-name column shows the literal word "Draw" with no logo and no
// score cells; the trailing column carries the X-outcome odds button.
function ScoreTable({
  homeTeam,
  awayTeam,
  homeLogoUrl,
  awayLogoUrl,
  liveScore,
  bestOf,
  isLive,
  sportSlug,
  homeTrailing,
  awayTrailing,
  drawTrailing,
}: {
  homeTeam: string;
  awayTeam: string;
  homeLogoUrl: string | null;
  awayLogoUrl: string | null;
  liveScore: LiveScore | null;
  bestOf: number | null;
  isLive: boolean;
  sportSlug: string;
  homeTrailing?: ReactNode;
  awayTrailing?: ReactNode;
  drawTrailing?: ReactNode;
}) {
  const tMatch = useTranslations("match");
  const matchWinnerLabel = tMatch("matchWinner");
  const periods = (liveScore?.periods ?? []).filter((p) => p.number != null);
  const periodByNumber = new Map<number, NonNullable<LiveScore["periods"]>[number]>();
  for (const p of periods) periodByNumber.set(p.number ?? 0, p);

  const homeSeries = liveScore?.home ?? 0;
  const awaySeries = liveScore?.away ?? 0;
  const currentMap = isLive ? liveScore?.currentMap ?? null : null;
  const scoreboard = liveScore?.scoreboard ?? null;

  // Number of map columns. Use bestOf when known so empty future maps
  // render as dashes (gives a stable "shape" for BO3+); fall back to the
  // periods we've observed. Cap at 5 to keep the row from getting huge
  // for esoteric formats.
  const mapCount = Math.min(5, Math.max(bestOf ?? 0, periods.length, 0));
  const cols = isLive && mapCount > 0 ? Array.from({ length: mapCount }, (_, i) => i + 1) : [];
  const showSeries = isLive && mapCount > 1;
  const hasTrailing =
    homeTrailing != null || awayTrailing != null || drawTrailing != null;

  // Grid template:
  //   name(1fr) [Σ] [map1..mapN] [trailing]
  // Number columns shrink on narrow viewports via clamp() so the name
  // track stays usable on a 360px phone. The odds button itself loses
  // its "1"/"2" label on mobile (see .oz-row-odd / .oz-odd-label in
  // globals.css), so the trailing column can be tighter.
  const seriesCol = "clamp(20px, 5.4vw, 28px)";
  const mapCol = "clamp(16px, 4.4vw, 24px)";
  const trailCol = "clamp(58px, 16vw, 92px)";
  const gridTemplate = [
    "minmax(0, 1fr)",
    showSeries ? seriesCol : null,
    ...cols.map(() => mapCol),
    hasTrailing ? trailCol : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      role="table"
      style={{
        display: "grid",
        gridTemplateColumns: gridTemplate,
        rowGap: 6,
        columnGap: 6,
        alignItems: "center",
        padding: "8px 12px",
        minWidth: 0,
      }}
    >
      {/* Header row — always rendered when the card has a trailing odds
          column so bettors see "Match winner" above the buttons. The
          first cell stays blank (it sits above the team-name column);
          numeric cols still label themselves Σ / map-number when live. */}
      {(showSeries || cols.length > 0 || hasTrailing) && (
        <div role="row" style={{ display: "contents" }}>
          <div />
          {showSeries && <ColHeader label="Σ" />}
          {cols.map((n) => (
            <ColHeader key={n} label={String(n)} live={currentMap === n} />
          ))}
          {hasTrailing && <TrailingHeader label={matchWinnerLabel} />}
        </div>
      )}

      <TeamScoreRow
        name={homeTeam}
        logoUrl={homeLogoUrl}
        series={homeSeries}
        cols={cols}
        showSeries={showSeries}
        getValue={(n) =>
          mapCellValue("home", n, periodByNumber.get(n), scoreboard, currentMap, sportSlug)
        }
        isLiveCol={(n) => currentMap === n}
        trailing={homeTrailing}
        hasTrailing={hasTrailing}
      />
      {drawTrailing ? (
        <DrawScoreRow
          showSeries={showSeries}
          colCount={cols.length}
          trailing={drawTrailing}
          hasTrailing={hasTrailing}
        />
      ) : null}
      <TeamScoreRow
        name={awayTeam}
        logoUrl={awayLogoUrl}
        series={awaySeries}
        cols={cols}
        showSeries={showSeries}
        getValue={(n) =>
          mapCellValue("away", n, periodByNumber.get(n), scoreboard, currentMap, sportSlug)
        }
        isLiveCol={(n) => currentMap === n}
        trailing={awayTrailing}
        hasTrailing={hasTrailing}
      />
    </div>
  );
}

// Middle "Draw" row for 3-way match-winner markets. Mirrors the grid
// layout of TeamScoreRow (so columns line up under the same header)
// but only renders content in the trailing odds slot — the "X" label
// on the button itself identifies the row as the draw outcome (kept
// visible on mobile via RowOddBtn's keepLabelOnMobile flag).
function DrawScoreRow({
  showSeries,
  colCount,
  trailing,
  hasTrailing,
}: {
  showSeries: boolean;
  colCount: number;
  trailing: ReactNode;
  hasTrailing: boolean;
}) {
  return (
    <>
      <div />
      {showSeries && <div />}
      {Array.from({ length: colCount }, (_, i) => (
        <div key={i} />
      ))}
      {hasTrailing && <div>{trailing}</div>}
    </>
  );
}

function ColHeader({ label, live = false }: { label: string; live?: boolean }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 9.5,
        color: live ? "var(--fg)" : "var(--fg-dim)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        textAlign: "center",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 3,
      }}
    >
      {live ? <LiveDot size={4} /> : null}
      {label}
    </div>
  );
}

// Header for the trailing odds column. Uses sentence-case "Match
// winner" so bettors immediately recognise the market type — the
// numeric column headers (Σ / 1 / 2 / 3) are too cryptic to carry
// this hint. Slightly tighter letter-spacing + nowrap+ellipsis so the
// label survives the ~58px trail column on narrow mobile viewports.
function TrailingHeader({ label }: { label: string }) {
  return (
    <div
      style={{
        fontSize: 10,
        color: "var(--fg-dim)",
        textAlign: "center",
        letterSpacing: "-0.01em",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {label}
    </div>
  );
}

function TeamScoreRow({
  name,
  logoUrl,
  series,
  cols,
  showSeries,
  getValue,
  isLiveCol,
  trailing,
  hasTrailing,
}: {
  name: string;
  logoUrl?: string | null;
  series: number;
  cols: number[];
  showSeries: boolean;
  getValue: (n: number) => number | null;
  isLiveCol: (n: number) => boolean;
  trailing?: ReactNode;
  hasTrailing: boolean;
}) {
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
        }}
      >
        <TeamMark tag={teamTag(name)} size={22} logoUrl={logoUrl} name={name} />
        <span
          style={{
            fontSize: 13.5,
            fontWeight: 500,
            letterSpacing: "-0.005em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            flex: 1,
          }}
        >
          {truncate(name, 24)}
        </span>
      </div>
      {showSeries && <SeriesCell series={series} />}
      {cols.map((n) => (
        <MapCell key={n} value={getValue(n)} live={isLiveCol(n)} />
      ))}
      {hasTrailing && <div>{trailing}</div>}
    </>
  );
}

// Series score cell on a list card. Tints green/red on change so the
// eye lands on the row that just moved when scrolling a long list.
// Border + radius come from inline style; the flash animation only
// touches background-color, so the box shape is unaffected.
function SeriesCell({ series }: { series: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useValueFlash(series, ref);
  return (
    <div
      ref={ref}
      className="mono tnum"
      style={{
        textAlign: "center",
        fontSize: 12.5,
        fontWeight: 600,
        color: "var(--fg)",
        padding: "2px 0",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-sm, 6px)",
        backgroundColor: "transparent",
      }}
    >
      {series}
    </div>
  );
}

// Per-map cell on a list card. Same flash semantics as the detail page,
// just smaller. Pre-match cells render "—" with no flash because
// useValueFlash skips null transitions.
function MapCell({ value, live }: { value: number | null; live: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useValueFlash(value, ref);
  return (
    <div
      ref={ref}
      className="mono tnum"
      style={{
        textAlign: "center",
        fontSize: 12.5,
        fontWeight: 500,
        color:
          value == null
            ? "var(--fg-dim)"
            : live
              ? "var(--fg)"
              : "var(--fg-muted)",
        borderRadius: 4,
      }}
    >
      {value == null ? "—" : value}
    </div>
  );
}

// Inline odds button used in the list card. One per team row, so the
// whole odds block becomes a single ~70px wide track instead of two
// ~80px buttons sitting next to both rows. Compact: 30px tall, label
// + price side-by-side.
function RowOddBtn({
  label,
  price,
  selected,
  locked,
  onClick,
  keepLabelOnMobile = false,
}: {
  label: string;
  price: number | null;
  selected: boolean;
  locked: boolean;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  // When true, the label stays visible on mobile (the `oz-odd-label`
  // class is dropped so the global mobile rule that hides it doesn't
  // apply). Used for the X button on the draw row, where there's no
  // team name on the left to identify the outcome — the label is the
  // only cue that this is the draw.
  keepLabelOnMobile?: boolean;
}) {
  // Same green/red flash as OddButton. Skipped while locked so an
  // inactive→active transition doesn't flash on resume.
  const flashRef = useRef<HTMLButtonElement | null>(null);
  useOddsFlash(locked ? null : price, flashRef);
  const baseStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
    width: "100%",
    height: 30,
    padding: "0 9px",
    background: selected ? "var(--accent)" : "var(--surface-2)",
    color: selected ? "var(--accent-fg)" : "var(--fg)",
    border: "1px solid",
    borderColor: selected ? "var(--accent)" : "var(--border)",
    borderRadius: 8,
    cursor: locked ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    transition: "all 140ms var(--ease)",
    opacity: locked ? 0.5 : 1,
  };
  // .oz-row-odd flips justify-content to center on mobile (the row it
  // sits in is already aligned with the team's name, so the "1"/"2"
  // label is redundant there). .oz-odd-label hides the label itself
  // at the same breakpoint. See globals.css.
  return (
    <button
      ref={flashRef}
      type="button"
      disabled={locked}
      onClick={onClick}
      className="oz-row-odd"
      style={baseStyle}
    >
      <span
        className={keepLabelOnMobile ? "mono" : "mono oz-odd-label"}
        style={{
          fontSize: 10.5,
          color: selected
            ? "color-mix(in oklab, var(--accent-fg) 70%, transparent)"
            : "var(--fg-muted)",
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      <span
        className="mono tnum"
        style={{
          fontSize: 12.5,
          fontWeight: 600,
          letterSpacing: "-0.01em",
        }}
      >
        {locked || price == null ? "—" : price.toFixed(2)}
      </span>
    </button>
  );
}

// Compact "N watching" pill next to the LIVE indicator. Hidden when
// count is 0 — the parent only renders it for live matches with an
// active room. The number is formatted with thousands separators so
// a 12 000-viewer Major final reads cleanly.
function ViewerCountPill({ count }: { count: number }) {
  const tMatch = useTranslations("match");
  const label = tMatch("watching", { count: count.toLocaleString() });
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 7px",
        borderRadius: 999,
        border: "1px solid var(--border)",
        background: "var(--surface)",
        color: "var(--fg-dim)",
        fontSize: 10.5,
        letterSpacing: "0.02em",
        flexShrink: 0,
      }}
      title={label}
    >
      <span
        style={{
          width: 4,
          height: 4,
          borderRadius: 999,
          background: "var(--fg-dim)",
          opacity: 0.8,
        }}
      />
      {label}
    </span>
  );
}
