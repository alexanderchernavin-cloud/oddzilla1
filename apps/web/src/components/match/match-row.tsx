"use client";

import Link from "next/link";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { Pill, LiveDot, TeamMark } from "@/components/ui/primitives";
import { TierMark, isFeaturedTier } from "@/components/ui/tier-mark";
import { useBetSlip } from "@/lib/bet-slip";
import { mapCellValue, type LiveScore } from "@/lib/live-score";
import type { SlipSelection } from "@oddzilla/types";

export interface ListMatch {
  id: string;
  homeTeam: string;
  awayTeam: string;
  scheduledAt: string | null;
  status: "not_started" | "live" | "closed" | "cancelled" | "suspended";
  bestOf?: number | null;
  liveScore?: LiveScore | null;
  tournament: { id: number; name: string; riskTier?: number | null };
  matchWinner: {
    marketId: string;
    home: { outcomeId: string; price: string | null; probability?: string | null };
    away: { outcomeId: string; price: string | null; probability?: string | null };
  } | null;
  topMarket?: TopMarketInline | null;
}

// Inline rendering of a curated Top market on a match card. The card
// shows two outcomes side-by-side; Top markets with a different outcome
// count fall back to "—" buttons + still allow click-through to the
// match page for the full picker.
export interface TopMarketInline {
  marketId: string;
  providerMarketId: number;
  specifiers: Record<string, string>;
  outcomes: Array<{
    outcomeId: string;
    name: string;
    publishedOdds: string | null;
    probability: string | null;
  }>;
}

export type MatchListTab = "match" | "top";

interface Props {
  match: ListMatch;
  sportSlug: string;
  sportShort: string;
  // Which inline market to render. Defaults to "match" — the existing
  // match-winner buttons. "top" renders the configured Top market when
  // the API supplied one for this match; otherwise the trailing column
  // shows "—" placeholders.
  tab?: MatchListTab;
}

export function MatchRow({ match, sportSlug, sportShort, tab = "match" }: Props) {
  const slip = useBetSlip();
  const isLive = match.status === "live";
  const showTop = tab === "top" && !!match.topMarket;
  const top = showTop ? match.topMarket! : null;

  function handlePick(side: "home" | "away", e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (!match.matchWinner) return;
    const o = match.matchWinner[side];
    if (!o.price) return;
    const selection: SlipSelection = {
      matchId: match.id,
      marketId: match.matchWinner.marketId,
      outcomeId: o.outcomeId,
      odds: o.price,
      probability: o.probability ?? undefined,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      marketLabel: "Match winner",
      outcomeLabel: side === "home" ? match.homeTeam : match.awayTeam,
      sportSlug,
    };
    if (slip.has(selection.marketId, selection.outcomeId)) {
      slip.remove(selection.marketId, selection.outcomeId);
    } else {
      slip.add(selection);
    }
  }

  function handleTopPick(slot: 0 | 1, e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (!top) return;
    const o = top.outcomes[slot];
    if (!o || !o.publishedOdds) return;
    const selection: SlipSelection = {
      matchId: match.id,
      marketId: top.marketId,
      outcomeId: o.outcomeId,
      odds: o.publishedOdds,
      probability: o.probability ?? undefined,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      marketLabel: `Market #${top.providerMarketId}`,
      outcomeLabel: outcomeLabelForCard(o, match.homeTeam, match.awayTeam),
      sportSlug,
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
  const topHomePicked =
    top && top.outcomes[0]
      ? slip.has(top.marketId, top.outcomes[0].outcomeId)
      : false;
  const topAwayPicked =
    top && top.outcomes[1]
      ? slip.has(top.marketId, top.outcomes[1].outcomeId)
      : false;

  const whenLabel = (() => {
    if (isLive) return null;
    if (!match.scheduledAt) return null;
    const d = new Date(match.scheduledAt);
    const now = new Date();
    const sameDay =
      d.getUTCFullYear() === now.getUTCFullYear() &&
      d.getUTCMonth() === now.getUTCMonth() &&
      d.getUTCDate() === now.getUTCDate();
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return sameDay ? `Today · ${time}` : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ` · ${time}`;
  })();

  const homePrice = match.matchWinner?.home.price
    ? Number(match.matchWinner.home.price)
    : null;
  const awayPrice = match.matchWinner?.away.price
    ? Number(match.matchWinner.away.price)
    : null;

  const topHomePrice = top?.outcomes[0]?.publishedOdds
    ? Number(top.outcomes[0].publishedOdds)
    : null;
  const topAwayPrice = top?.outcomes[1]?.publishedOdds
    ? Number(top.outcomes[1].publishedOdds)
    : null;

  const homeOdds = top ? (
    <RowOddBtn
      label={shortOutcomeLabel(top.outcomes[0], "1", match.homeTeam)}
      price={topHomePrice}
      selected={topHomePicked}
      locked={!topHomePrice}
      onClick={(e) => handleTopPick(0, e)}
    />
  ) : (
    <RowOddBtn
      label="1"
      price={homePrice}
      selected={homePicked}
      locked={!homePrice}
      onClick={(e) => handlePick("home", e)}
    />
  );
  const awayOdds = top ? (
    <RowOddBtn
      label={shortOutcomeLabel(top.outcomes[1], "2", match.awayTeam)}
      price={topAwayPrice}
      selected={topAwayPicked}
      locked={!topAwayPrice}
      onClick={(e) => handleTopPick(1, e)}
    />
  ) : (
    <RowOddBtn
      label="2"
      price={awayPrice}
      selected={awayPicked}
      locked={!awayPrice}
      onClick={(e) => handlePick("away", e)}
    />
  );

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
            <Pill tone="live">
              <LiveDot size={6} /> LIVE
            </Pill>
          ) : (
            whenLabel && (
              <span
                className="mono"
                style={{ fontSize: 11, color: "var(--fg-muted)", flexShrink: 0 }}
              >
                {whenLabel}
              </span>
            )
          )}
        </div>

        <ScoreTable
          homeTeam={match.homeTeam}
          awayTeam={match.awayTeam}
          liveScore={match.liveScore ?? null}
          bestOf={match.bestOf ?? null}
          isLive={isLive}
          sportSlug={sportSlug}
          homeTrailing={homeOdds}
          awayTrailing={awayOdds}
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

// Compact label for the inline Top button. Tries to derive a short token
// from the outcome name (numeric outcome ids → "1"/"2", "under"/"over"
// → "U"/"O", team-name outcomes → first letter of the team's tag, …);
// falls back to the supplied default ("1"/"2"). Keeps the card row tidy
// when the underlying market has long outcome names.
function shortOutcomeLabel(
  o: { outcomeId: string; name: string } | undefined,
  fallback: string,
  teamHint: string,
): string {
  if (!o) return fallback;
  const name = (o.name || "").toLowerCase();
  if (name === "under") return "U";
  if (name === "over") return "O";
  if (name === "draw") return "X";
  if (o.outcomeId === "1" || o.outcomeId === "2" || o.outcomeId === "3") {
    return o.outcomeId;
  }
  if (name && teamHint.toLowerCase().startsWith(name.split(/\s+/)[0] ?? "")) {
    return teamTag(teamHint).slice(0, 2);
  }
  return fallback;
}

// Resolve a human-readable outcome label for the bet slip when the user
// clicks an inline Top button. Mirrors renderOutcomeLabel on the API
// side at a much simpler level — list cards don't render templated
// names, just the raw outcome name (or team name for home/away).
function outcomeLabelForCard(
  o: { outcomeId: string; name: string },
  homeTeam: string,
  awayTeam: string,
): string {
  const lower = (o.name || "").toLowerCase();
  if (lower === "home") return homeTeam;
  if (lower === "away") return awayTeam;
  if (lower === "draw") return "Draw";
  if (lower === "under") return "Under";
  if (lower === "over") return "Over";
  return o.name || o.outcomeId;
}

// ScoreTable renders a two-row mini-scoreboard mirroring the match-detail
// page's Scoreboard but in compact form for list cards:
//   [team mark + name] | Σ | Map 1 | Map 2 | Map N | [trailing]
// `homeTrailing` / `awayTrailing` add a per-row trailing cell — used by
// MatchRow to slot the odds button vertically aligned with each team
// row instead of as a separate 2-column block to the right. That gives
// the name column a much wider track on narrow viewports.
function ScoreTable({
  homeTeam,
  awayTeam,
  liveScore,
  bestOf,
  isLive,
  sportSlug,
  homeTrailing,
  awayTrailing,
}: {
  homeTeam: string;
  awayTeam: string;
  liveScore: LiveScore | null;
  bestOf: number | null;
  isLive: boolean;
  sportSlug: string;
  homeTrailing?: ReactNode;
  awayTrailing?: ReactNode;
}) {
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
  const hasTrailing = homeTrailing != null || awayTrailing != null;

  // Grid template:
  //   name(1fr) [Σ] [map1..mapN] [trailing]
  // Number columns shrink on narrow viewports via clamp() so the name
  // track stays usable on a 360px phone — empirically the previous fixed
  // 26px columns + 32px series squeezed names down to a single letter.
  const seriesCol = "clamp(22px, 6vw, 30px)";
  const mapCol = "clamp(18px, 5vw, 26px)";
  const trailCol = "clamp(64px, 19vw, 92px)";
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
      {/* Header row — only when there are numeric columns to label.
          Pre-match has neither series nor maps, so the header is suppressed
          to keep the card short. */}
      {(showSeries || cols.length > 0) && (
        <div role="row" style={{ display: "contents" }}>
          <div />
          {showSeries && <ColHeader label="Σ" />}
          {cols.map((n) => (
            <ColHeader key={n} label={String(n)} live={currentMap === n} />
          ))}
          {hasTrailing && <div />}
        </div>
      )}

      <TeamScoreRow
        name={homeTeam}
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
      <TeamScoreRow
        name={awayTeam}
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

function TeamScoreRow({
  name,
  series,
  cols,
  showSeries,
  getValue,
  isLiveCol,
  trailing,
  hasTrailing,
}: {
  name: string;
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
        <TeamMark tag={teamTag(name)} size={22} />
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
      {showSeries && (
        <div
          className="mono tnum"
          style={{
            textAlign: "center",
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--fg)",
            padding: "2px 0",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-sm, 6px)",
          }}
        >
          {series}
        </div>
      )}
      {cols.map((n) => {
        const v = getValue(n);
        const live = isLiveCol(n);
        return (
          <div
            key={n}
            className="mono tnum"
            style={{
              textAlign: "center",
              fontSize: 12.5,
              fontWeight: 500,
              color: v == null ? "var(--fg-dim)" : live ? "var(--fg)" : "var(--fg-muted)",
            }}
          >
            {v == null ? "—" : v}
          </div>
        );
      })}
      {hasTrailing && <div>{trailing}</div>}
    </>
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
}: {
  label: string;
  price: number | null;
  selected: boolean;
  locked: boolean;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
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
  return (
    <button type="button" disabled={locked} onClick={onClick} style={baseStyle}>
      <span
        className="mono"
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
