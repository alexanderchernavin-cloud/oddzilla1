"use client";

// Match-detail Scoreboard with live updates. Subscribes to the shared
// WebSocket via `useLiveScore(matchId)` and overlays the latest
// scoreboard payload on top of the SSR snapshot. Without this,
// matches.live_score reads were frozen at page-render time and the
// per-map cells / current-map highlight only refreshed on a hard
// reload.

import { useMemo, useRef } from "react";
import { LiveDot, TeamMark } from "@/components/ui/primitives";
import { useLiveScore, useLiveMatchStatus } from "@/lib/use-live-odds";
import { useValueFlash } from "@/lib/use-odds-flash";
import {
  mapCellValue,
  servingSide,
  type LiveScore,
  type LiveScorePeriod,
  type LiveScoreScoreboard,
} from "@/lib/live-score";
import { ServeMark } from "@/components/match/serve-mark";
import { useTranslations } from "@/lib/i18n";

type MatchStatus = "not_started" | "live" | "closed" | "cancelled" | "suspended";

export function LiveScoreboard({
  matchId,
  homeTeam,
  awayTeam,
  homeLogoUrl,
  awayLogoUrl,
  bestOf,
  initialLiveScore,
  initialStatus,
  sportSlug,
}: {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  homeLogoUrl: string | null;
  awayLogoUrl: string | null;
  bestOf: number | null;
  initialLiveScore: LiveScore | null;
  initialStatus: MatchStatus;
  sportSlug: string;
}) {
  // Live score wins over SSR baseline as soon as the first frame lands.
  // Both can be null pre-match; the merged value drives every derived
  // input below (currentMap, periods, scoreboard, series totals).
  const liveOverride = useLiveScore(matchId);
  const liveScore = liveOverride ?? initialLiveScore;
  // Lifecycle status also overlays SSR — once the backend flips the
  // match to closed/cancelled, the scoreboard drops its current-map
  // highlight even before the bettor refreshes. Without this the row
  // headers keep marking the (now-final) map as the live one.
  const liveStatus = useLiveMatchStatus(matchId);
  const isLive = (liveStatus?.status ?? initialStatus) === "live";

  const homeSeries = liveScore?.home ?? 0;
  const awaySeries = liveScore?.away ?? 0;

  // The number of map columns. Prefer bestOf so unplayed maps render as
  // placeholders; fall back to the count of periods we've seen so the
  // table doesn't shrink to zero columns pre-match for sports with no
  // bestOf metadata.
  const mapCount = useMemo(() => {
    const periodCount = (liveScore?.periods ?? []).filter(
      (p) => p.number != null,
    ).length;
    return Math.max(bestOf ?? 0, periodCount, 0);
  }, [liveScore, bestOf]);

  return (
    <Scoreboard
      homeTeam={homeTeam}
      awayTeam={awayTeam}
      homeLogoUrl={homeLogoUrl}
      awayLogoUrl={awayLogoUrl}
      homeSeries={homeSeries}
      awaySeries={awaySeries}
      mapCount={mapCount}
      liveScore={liveScore}
      isLive={isLive}
      sportSlug={sportSlug}
    />
  );
}

// Scoreboard renders a two-row table:
//   [team mark] [team name] | Score | 1 | 2 | … | N
// where Score is the series score (boxed) and the numeric columns are
// the per-map metric (rounds for CS2/Valorant, kills for Dota/LoL, etc.).
// The currently-live map column is highlighted; unplayed maps render
// dimmed dashes.
function Scoreboard({
  homeTeam,
  awayTeam,
  homeLogoUrl,
  awayLogoUrl,
  homeSeries,
  awaySeries,
  mapCount,
  liveScore,
  isLive,
  sportSlug,
}: {
  homeTeam: string;
  awayTeam: string;
  homeLogoUrl: string | null;
  awayLogoUrl: string | null;
  homeSeries: number;
  awaySeries: number;
  mapCount: number;
  liveScore: LiveScore | null;
  isLive: boolean;
  sportSlug: string;
}) {
  const t = useTranslations("matchWidgets");
  const periods = (liveScore?.periods ?? []).filter((p) => p.number != null);
  const periodByNumber = new Map<number, LiveScorePeriod>();
  for (const p of periods) periodByNumber.set(p.number ?? 0, p);

  const currentMap = isLive ? liveScore?.currentMap ?? null : null;
  const scoreboard = liveScore?.scoreboard ?? null;
  // Tennis / table tennis / volleyball only — null everywhere else.
  const serving = servingSide(liveScore, isLive);

  const cols = mapCount > 0 ? Array.from({ length: mapCount }, (_, i) => i + 1) : [];

  const extraRows =
    isLive && scoreboard ? extraScoreRows(scoreboard, sportSlug) : [];

  // Grid template: [team] [score] [map1] [map2] … [mapN]
  // Team column flexes; numeric columns are fixed-width and centered.
  // Bump per-map width when extras render so paired values like
  // "23k:28k" fit on the same row without crowding. Both score and
  // map cell widths come from CSS variables on .oz-scoreboard so the
  // mobile breakpoint (≤1099px) can swap a compact set in without
  // the JSX needing to know about the viewport.
  const mapColVar = extraRows.length > 0
    ? "var(--sb-map-col-extras)"
    : "var(--sb-map-col)";
  const gridTemplate = `minmax(0, 1fr) var(--sb-score-col)${cols.length ? " " + cols.map(() => mapColVar).join(" ") : ""}`;

  return (
    <div
      className="oz-scoreboard"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div
        role="table"
        style={{
          display: "grid",
          gridTemplateColumns: gridTemplate,
          rowGap: "var(--sb-row-gap)",
          columnGap: "var(--sb-col-gap)",
          alignItems: "center",
        }}
      >
        {/* Header row */}
        <div role="row" style={{ display: "contents" }}>
          <div />
          <ColHeader label={t("scoreboard.score")} />
          {cols.map((n) => (
            <ColHeader
              key={n}
              label={String(n)}
              live={currentMap === n}
            />
          ))}
        </div>

        {/* Home row */}
        <TeamRow
          name={homeTeam}
          logoUrl={homeLogoUrl}
          markSlot={!!(homeLogoUrl || awayLogoUrl)}
          series={homeSeries}
          cols={cols}
          getValue={(n) => mapCellValue("home", n, periodByNumber.get(n), scoreboard, currentMap, sportSlug)}
          isLiveCol={(n) => currentMap === n}
          serving={serving === "home"}
        />

        {/* Away row */}
        <TeamRow
          name={awayTeam}
          logoUrl={awayLogoUrl}
          markSlot={!!(homeLogoUrl || awayLogoUrl)}
          series={awaySeries}
          cols={cols}
          getValue={(n) => mapCellValue("away", n, periodByNumber.get(n), scoreboard, currentMap, sportSlug)}
          isLiveCol={(n) => currentMap === n}
          serving={serving === "away"}
        />

        {/* Secondary stats (Towers, Gold for Dota/LoL). Same grid columns
            as the team rows so values line up under the live map column,
            but smaller + dimmer so kills stays the primary metric. */}
        {extraRows.map((row, i) => (
          <ExtraRow
            key={row.labelKey}
            label={t(`scoreboard.${row.labelKey}`)}
            cols={cols}
            currentMap={currentMap}
            homeValue={row.homeValue}
            awayValue={row.awayValue}
            format={row.format}
            firstExtra={i === 0}
          />
        ))}
      </div>
    </div>
  );
}

function ColHeader({ label, live = false }: { label: string; live?: boolean }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 10.5,
        color: live ? "var(--fg)" : "var(--fg-dim)",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        textAlign: "center",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
      }}
    >
      {live ? <LiveDot size={5} /> : null}
      {label}
    </div>
  );
}

function TeamRow({
  name,
  logoUrl,
  markSlot,
  series,
  cols,
  getValue,
  isLiveCol,
  serving,
}: {
  name: string;
  logoUrl?: string | null;
  /**
   * TeamMark renders nothing without a picture. True when either side
   * has one, so the row without keeps a same-sized empty slot and the
   * two names stay flush; false when neither does, and the names sit at
   * the left edge.
   */
  markSlot: boolean;
  series: number;
  cols: number[];
  getValue: (n: number) => number | null;
  isLiveCol: (n: number) => boolean;
  /** This side is serving (tennis / table tennis / volleyball). */
  serving?: boolean;
}) {
  const tag = teamTag(name);
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sb-cell-gap)",
          minWidth: 0,
        }}
      >
        {/* 34px fits inside the row the bordered SCORE box already sets
            (16px font at 1.45 line-height + 6px padding each side + the
            border comes to ~37px), so the crest grows without the row
            moving. Mobile has no such headroom — its score cell is bare
            14px text — so the mark there is the tallest thing in the
            row and stays at 22. */}
        {markSlot ? (
          <>
            {/* The breakpoint CSS flips these two with !important, which
                wins over the inline display below; the inline width /
                height are what hold the slot when the mark is empty. */}
            <span
              className="oz-sb-mark-desktop"
              style={{ display: "inline-flex", width: 34, height: 34, flexShrink: 0 }}
            >
              <TeamMark tag={tag} size={34} logoUrl={logoUrl} name={name} />
            </span>
            <span
              className="oz-sb-mark-mobile"
              style={{ width: 22, height: 22, flexShrink: 0 }}
            >
              <TeamMark tag={tag} size={22} logoUrl={logoUrl} name={name} />
            </span>
          </>
        ) : null}
        <span
          style={{
            fontWeight: 500,
            fontSize: "var(--sb-team-font)",
            letterSpacing: "-0.01em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
            // See the same note in match-row.tsx: shrink-to-fit keeps the
            // serve mark next to the name instead of against the score
            // column.
            flex: "0 1 auto",
          }}
        >
          <span className="oz-sb-name-desktop">{truncateName(name, 24)}</span>
          <span className="oz-sb-name-mobile">{name}</span>
        </span>
        {/* Its own flex item, after the name rather than inside it, so a
            long doubles pairing truncates without taking the marker
            with it. */}
        {serving ? <ServeMark size={8} /> : null}
      </div>

      <SeriesCell series={series} />

      {cols.map((n) => (
        <MapCell key={n} value={getValue(n)} live={isLiveCol(n)} />
      ))}
    </>
  );
}

// Series-score cell with a flash-on-change tint. The score box already
// has a hard-coded border + radius via the .oz-sb-score class in
// globals.css; we add a transparent backgroundColor as the animation
// target so the tint paints inside the box, not over the border.
function SeriesCell({ series }: { series: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useValueFlash(series, ref);
  return (
    <div
      ref={ref}
      className="mono tnum oz-sb-score"
      style={{
        textAlign: "center",
        fontSize: "var(--sb-score-font)",
        fontWeight: 500,
        color: "var(--fg)",
        backgroundColor: "transparent",
      }}
    >
      {series}
    </div>
  );
}

// Per-map cell with a flash-on-change tint. Kills (Dota / LoL), rounds
// (CS2 / Valorant), goals — whatever mapCellValue resolves for the row.
// borderRadius keeps the green/red wash from looking like a hard
// rectangle behind a single digit.
function MapCell({ value, live }: { value: number | null; live: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useValueFlash(value, ref);
  return (
    <div
      ref={ref}
      className="mono tnum"
      style={{
        textAlign: "center",
        fontSize: "var(--sb-map-font)",
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

function ExtraRow({
  label,
  cols,
  currentMap,
  homeValue,
  awayValue,
  format,
  firstExtra,
}: {
  label: string;
  cols: number[];
  currentMap: number | null;
  homeValue: number;
  awayValue: number;
  format: (n: number) => string;
  firstExtra: boolean;
}) {
  const topPad = firstExtra ? 6 : 0;
  return (
    <>
      <div
        className="mono"
        style={{
          fontSize: 10.5,
          color: "var(--fg-dim)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          textAlign: "right",
          paddingTop: topPad,
        }}
      >
        {label}
      </div>
      <div style={{ paddingTop: topPad }} />
      {cols.map((n) => {
        const live = currentMap === n;
        if (!live) {
          return <div key={n} style={{ paddingTop: topPad }} />;
        }
        return (
          <ExtraCell
            key={n}
            homeValue={homeValue}
            awayValue={awayValue}
            format={format}
            paddingTop={topPad}
          />
        );
      })}
    </>
  );
}

// ExtraCell renders the home:away pair for a secondary stat (Towers /
// Turrets / Gold) inside the live map column. Each side gets its own
// span + ref + flash hook, so a Dota tower destruction tints just the
// digits that changed (e.g. only the away side flashes when the away
// team destroys a tower) instead of bathing the whole "0:4" pair.
function ExtraCell({
  homeValue,
  awayValue,
  format,
  paddingTop,
}: {
  homeValue: number;
  awayValue: number;
  format: (n: number) => string;
  paddingTop: number;
}) {
  const homeRef = useRef<HTMLSpanElement>(null);
  const awayRef = useRef<HTMLSpanElement>(null);
  useValueFlash(homeValue, homeRef);
  useValueFlash(awayValue, awayRef);
  const sideStyle = {
    display: "inline-block",
    padding: "0 2px",
    borderRadius: 3,
  } as const;
  return (
    <div
      className="mono tnum"
      style={{
        textAlign: "center",
        fontSize: 11,
        fontWeight: 400,
        color: "var(--fg-dim)",
        paddingTop,
      }}
    >
      <span ref={homeRef} style={sideStyle}>
        {format(homeValue)}
      </span>
      :
      <span ref={awayRef} style={sideStyle}>
        {format(awayValue)}
      </span>
    </div>
  );
}

function extraScoreRows(
  sb: LiveScoreScoreboard,
  sportSlug: string,
): {
  labelKey: "towers" | "turrets" | "gold";
  homeValue: number;
  awayValue: number;
  format: (n: number) => string;
}[] {
  const slug = sportSlug.toLowerCase();
  const out: {
    labelKey: "towers" | "turrets" | "gold";
    homeValue: number;
    awayValue: number;
    format: (n: number) => string;
  }[] = [];

  const isDotaLikeSlug =
    slug === "dota2" ||
    slug === "dota" ||
    slug === "lol" ||
    slug === "leagueoflegends" ||
    slug === "league-of-legends";

  if (!isDotaLikeSlug) return out;

  if (sb.homeDestroyedTowers != null && sb.awayDestroyedTowers != null) {
    out.push({
      labelKey: "towers",
      homeValue: sb.homeDestroyedTowers,
      awayValue: sb.awayDestroyedTowers,
      format: (n) => String(n),
    });
  }
  if (sb.homeDestroyedTurrets != null && sb.awayDestroyedTurrets != null) {
    out.push({
      labelKey: "turrets",
      homeValue: sb.homeDestroyedTurrets,
      awayValue: sb.awayDestroyedTurrets,
      format: (n) => String(n),
    });
  }
  if (sb.homeGold != null && sb.awayGold != null) {
    out.push({
      labelKey: "gold",
      homeValue: sb.homeGold,
      awayValue: sb.awayGold,
      format: formatGold,
    });
  }

  return out;
}

function teamTag(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 3)
    .map((w) => w[0])
    .join("")
    .slice(0, 4);
}

function truncateName(name: string, max: number): string {
  if (name.length <= max) return name;
  return name.slice(0, max).trimEnd() + "..";
}

function formatGold(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}
