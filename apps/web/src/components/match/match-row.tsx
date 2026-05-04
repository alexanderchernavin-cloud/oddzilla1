"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { Pill, LiveDot, OddButton, TeamMark } from "@/components/ui/primitives";
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
  tournament: { id: number; name: string };
  matchWinner: {
    marketId: string;
    home: { outcomeId: string; price: string | null; probability?: string | null };
    away: { outcomeId: string; price: string | null; probability?: string | null };
  } | null;
}

interface Props {
  match: ListMatch;
  sportSlug: string;
  sportShort: string;
}

export function MatchRow({ match, sportSlug, sportShort }: Props) {
  const slip = useBetSlip();
  const isLive = match.status === "live";

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

  const homePicked = match.matchWinner
    ? slip.has(match.matchWinner.marketId, match.matchWinner.home.outcomeId)
    : false;
  const awayPicked = match.matchWinner
    ? slip.has(match.matchWinner.marketId, match.matchWinner.away.outcomeId)
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

  return (
    <Link
      href={`/match/${match.id}`}
      style={{ textDecoration: "none", color: "inherit" }}
    >
      <article
        className="card"
        style={{
          borderRadius: "var(--r-md)",
          overflow: "hidden",
          transition: "border-color 160ms var(--ease)",
          cursor: "pointer",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 12px",
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
          <span
            style={{
              color: "var(--fg-muted)",
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

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            gap: 12,
            padding: "10px 12px",
            alignItems: "center",
          }}
        >
          <ScoreTable
            homeTeam={match.homeTeam}
            awayTeam={match.awayTeam}
            liveScore={match.liveScore ?? null}
            bestOf={match.bestOf ?? null}
            isLive={isLive}
            sportSlug={sportSlug}
          />

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 6,
              width: "clamp(130px, 38vw, 200px)",
            }}
          >
            <OddButton
              price={match.matchWinner?.home.price ? Number(match.matchWinner.home.price) : null}
              label="1"
              selected={homePicked}
              locked={!match.matchWinner?.home.price}
              onClick={(e) => handlePick("home", e)}
            />
            <OddButton
              price={match.matchWinner?.away.price ? Number(match.matchWinner.away.price) : null}
              label="2"
              selected={awayPicked}
              locked={!match.matchWinner?.away.price}
              onClick={(e) => handlePick("away", e)}
            />
          </div>
        </div>
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

// ScoreTable renders a two-row mini-scoreboard mirroring the match-detail
// page's Scoreboard but in compact form for list cards:
//   [team mark + name] | Series | Map 1 | Map 2 | Map N
// Uses the same metric-picking rules (rounds for CS2, kills for Dota,
// generic home/away_score otherwise — see lib/live-score.ts) so a value
// shown on a list card always matches the equivalent cell on the
// match-detail page. Pre-match the row collapses to just team names so
// the layout doesn't fill with "—" placeholders for unstarted maps.
function ScoreTable({
  homeTeam,
  awayTeam,
  liveScore,
  bestOf,
  isLive,
  sportSlug,
}: {
  homeTeam: string;
  awayTeam: string;
  liveScore: LiveScore | null;
  bestOf: number | null;
  isLive: boolean;
  sportSlug: string;
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

  // Pre-match: just the names, no numeric columns.
  if (!isLive) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
        <NameOnlyRow name={homeTeam} />
        <NameOnlyRow name={awayTeam} />
      </div>
    );
  }

  // Live: [team] [series] [map1..mapN]. Series column is only useful when
  // there's more than one map; for BO1 it duplicates map 1 — drop it.
  const showSeries = mapCount > 1;
  const gridTemplate = `minmax(0, 1fr)${showSeries ? " 32px" : ""}${
    cols.length ? " " + cols.map(() => "26px").join(" ") : ""
  }`;

  return (
    <div
      role="table"
      style={{
        display: "grid",
        gridTemplateColumns: gridTemplate,
        rowGap: 6,
        columnGap: 8,
        alignItems: "center",
        minWidth: 0,
      }}
    >
      <div role="row" style={{ display: "contents" }}>
        <div />
        {showSeries && <ColHeader label="Σ" />}
        {cols.map((n) => (
          <ColHeader key={n} label={String(n)} live={currentMap === n} />
        ))}
      </div>
      <TeamScoreRow
        name={homeTeam}
        series={homeSeries}
        cols={cols}
        showSeries={showSeries}
        getValue={(n) =>
          mapCellValue("home", n, periodByNumber.get(n), scoreboard, currentMap, sportSlug)
        }
        isLiveCol={(n) => currentMap === n}
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
      />
    </div>
  );
}

function NameOnlyRow({ name }: { name: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
      <TeamMark tag={teamTag(name)} size={24} />
      <span
        style={{
          fontSize: 14,
          fontWeight: 500,
          letterSpacing: "-0.005em",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
          flex: 1,
        }}
      >
        {truncate(name, 22)}
      </span>
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
        letterSpacing: "0.08em",
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
}: {
  name: string;
  series: number;
  cols: number[];
  showSeries: boolean;
  getValue: (n: number) => number | null;
  isLiveCol: (n: number) => boolean;
}) {
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          minWidth: 0,
        }}
      >
        <TeamMark tag={teamTag(name)} size={24} />
        <span
          style={{
            fontSize: 14,
            fontWeight: 500,
            letterSpacing: "-0.005em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            flex: 1,
          }}
        >
          {truncate(name, 22)}
        </span>
      </div>
      {showSeries && (
        <div
          className="mono tnum"
          style={{
            textAlign: "center",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--fg)",
            padding: "3px 0",
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
              fontSize: 13,
              fontWeight: 500,
              color: v == null ? "var(--fg-dim)" : live ? "var(--fg)" : "var(--fg-muted)",
            }}
          >
            {v == null ? "—" : v}
          </div>
        );
      })}
    </>
  );
}
