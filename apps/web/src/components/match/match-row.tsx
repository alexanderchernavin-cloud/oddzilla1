"use client";

import Link from "next/link";
import { memo, useRef } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { Pill, LiveDot, TeamMark } from "@/components/ui/primitives";
import { TierMark, isFeaturedTier } from "@/components/ui/tier-mark";
import { I } from "@/components/ui/icons";
import { useBetSlip } from "@/lib/bet-slip";
import { mapCellValue, type LiveScore } from "@/lib/live-score";
import { useSidePanels, type PanelSide } from "@/lib/side-panel";
import { useOddsFlash, useValueFlash } from "@/lib/use-odds-flash";
import { useTranslations } from "@/lib/i18n";
import { LocalDateTime } from "./local-datetime";
import type { SlipSelection } from "@oddzilla/types";
// Value import via the subpath, never the barrel — see the note in
// packages/types/src/odds.ts.
import { formatOddsDisplay, isBettableOdds } from "@oddzilla/types/odds";

/**
 * One inline match-winner price on a list card.
 *
 * `price` is ALREADY the boosted value when `boost` is set — the list
 * endpoints apply ZillaBoost server-side (the match page recomputes it
 * client-side per WS tick, but a card has no per-outcome subscription).
 * `boost.originalPrice` is the pre-boost figure for the struck-through
 * display, and `boost.ruleId` must ride into the slip so placement
 * prices the leg at the boosted number rather than the raw one.
 */
export interface ListMatchOutcome {
  outcomeId: string;
  price: string | null;
  probability?: string | null;
  boost?: {
    ruleId: string;
    boostPct: number;
    endsAt: string | null;
    originalPrice: string;
  } | null;
}

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
    home: ListMatchOutcome;
    away: ListMatchOutcome;
    // Set when the underlying market is 3-way (BO2 esports, 1X2 sports).
    // The card grows a "Draw" row between home and away when present.
    draw?: ListMatchOutcome | null;
    /**
     * Resolved ZillaBoost inputs for this market, so the live merge can
     * re-price the row from WS ticks instead of reverting to raw odds.
     * Present whenever a rule COVERS the market, even if it currently
     * prices to no visible change — a tick can make it materialise.
     */
    boostRule?: { ruleId: string; boostPct: number; endsAt: string | null } | null;
    boostSelections?: Record<
      string,
      { ruleId: string; boostPct: number; endsAt: string | null }
    > | null;
  } | null;
}

interface Props {
  match: ListMatch;
  sportSlug: string;
  sportShort: string;
}

// Memoized: MatchListTabs holds five aggregated live-state objects, so any
// single odds/score/status tick on any visible match re-renders the list
// component. mergeMatchWithLive already returns a referentially-identical
// `match` object for every row the tick didn't touch (precisely so React can
// skip them) — but that short-circuit only fires if the row is memoized.
// Without this, one tick re-rendered all ~140 rows (each with odds buttons,
// score table, team imgs, 2 useTranslations); with it, only affected rows
// re-render. Props are memo-friendly: `match` identity is stable across
// untouched ticks, the rest are primitives. (The slip-context churn that
// would otherwise defeat this is addressed separately — see bet-slip.tsx
// dropping per-tick pendingOdds persistence.)
export const MatchRow = memo(function MatchRow({
  match,
  sportSlug,
  sportShort,
}: Props) {
  const slip = useBetSlip();
  const sidePanels = useSidePanels();
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
      // Carry the ZillaBoost rule so placement prices this leg at the
      // boosted number shown on the card. Without it POST /bets would
      // fall back to the raw published price — and since a typical
      // boost sits inside the 5% drift tolerance, the bet would be
      // silently ACCEPTED at the lower raw price rather than rejected.
      customBoostRuleId: o.boost?.ruleId,
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

  // ZillaBoost, priced server-side for list cards (the match page
  // recomputes client-side per WS tick, but a card has no per-outcome
  // subscription). `price` above is ALREADY the boosted value when a
  // boost applies; these carry the pre-boost original for the struck
  // -through figure, mirroring the match page's boosted cells.
  const homeOriginal = match.matchWinner?.home.boost?.originalPrice ?? null;
  const awayOriginal = match.matchWinner?.away.boost?.originalPrice ?? null;
  const drawOriginal = match.matchWinner?.draw?.boost?.originalPrice ?? null;

  const homeOdds = (
    <RowOddBtn
      label="1"
      price={homePrice}
      selected={homePicked}
      locked={!homePrice}
      boosted={!!match.matchWinner?.home.boost}
      originalPrice={homeOriginal ? Number(homeOriginal) : null}
      onClick={(e) => handlePick("home", e)}
    />
  );
  const awayOdds = (
    <RowOddBtn
      label="2"
      price={awayPrice}
      selected={awayPicked}
      locked={!awayPrice}
      boosted={!!match.matchWinner?.away.boost}
      originalPrice={awayOriginal ? Number(awayOriginal) : null}
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
      boosted={!!match.matchWinner?.draw?.boost}
      originalPrice={drawOriginal ? Number(drawOriginal) : null}
      onClick={(e) => handlePick("draw", e)}
      // Keep the "X" visible on mobile — without a team name on its
      // row, the label is the only cue this is the draw outcome.
      keepLabelOnMobile
      // Half height. The draw is the least-picked cell on a 1X2 card and
      // its row carries nothing else, so at full size it added a whole
      // team-row's worth of height to every football card for a button
      // few bettors touch (operator call, 2026-09-06).
      compact
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
    <div className="oz-match-row">
      <SidePanelButton
        side="left"
        matchId={match.id}
        active={sidePanels.left === match.id}
        onToggle={() => sidePanels.toggle("left", match.id)}
      />
      <Link
        href={`/match/${match.id}`}
        style={{ textDecoration: "none", color: "inherit", flex: 1, minWidth: 0 }}
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
          {featured && (
            <TierMark tier={tier} size={11} label={tMatch("topTournamentTitle")} />
          )}
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
              <LiveDot size={6} /> {tCommon("live")}
            </Pill>
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
      <SidePanelButton
        side="right"
        matchId={match.id}
        active={sidePanels.right === match.id}
        onToggle={() => sidePanels.toggle("right", match.id)}
      />
    </div>
  );
});

// Tall vertical button on the left or right edge of a match card. Only
// visible on ultra-wide viewports where the side-panel iframes can
// actually fit (CSS-gated via `.oz-match-row` + a min-width media in
// globals.css). Active state ties to which match is currently mounted
// in that side's panel, so a second click closes it.
function SidePanelButton({
  side,
  matchId: _matchId,
  active,
  onToggle,
}: {
  side: PanelSide;
  matchId: string;
  active: boolean;
  onToggle: () => void;
}) {
  const Icon = side === "left" ? I.PanelLeft : I.PanelRight;
  const label =
    side === "left"
      ? active
        ? "Close left panel"
        : "Open match in left panel"
      : active
        ? "Close right panel"
        : "Open match in right panel";
  return (
    <button
      type="button"
      className="oz-match-side-btn"
      data-side={side}
      data-active={active ? "true" : "false"}
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
    >
      <Icon size={16} />
    </button>
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
  // TeamMark renders nothing without a picture. When only one side has
  // one, the other row still holds an empty slot of the same size so the
  // two names stay flush; when neither does, no slot at all and the
  // names sit at the left edge.
  const markSlot = !!(homeLogoUrl || awayLogoUrl);

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
        markSlot={markSlot}
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
        markSlot={markSlot}
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
  markSlot,
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
  /** Hold a crest-sized slot even when this row has no picture. */
  markSlot: boolean;
}) {
  const markSize = hasTrailing ? 28 : 24;
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
        {/* Sized to the row's tallest neighbour so the crest grows without
            the row moving: the odds button in the trailing column is a
            fixed 30px, the score / map cells without it are ~24px. */}
        {markSlot ? (
          <span
            style={{
              display: "inline-flex",
              width: markSize,
              height: markSize,
              flexShrink: 0,
            }}
          >
            <TeamMark tag={teamTag(name)} size={markSize} logoUrl={logoUrl} name={name} />
          </span>
        ) : null}
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
// ~80px buttons sitting next to both rows. 30px tall, label + price
// side-by-side; `compact` halves that for the draw row.
const ROW_ODD_HEIGHT = 30;
// Half of ROW_ODD_HEIGHT, rounded up one so the 1px borders and the
// 9.5px label centre on whole pixels. The visible box is this tall; the
// TAP target is not — `.oz-row-odd[data-compact]` in globals.css grows
// the hit area 4px above and below through a pseudo-element, into the
// row gap, so a phone still gets a 24px target (WCAG 2.5.8) under a
// button that only takes 16px of the card.
const ROW_ODD_HEIGHT_COMPACT = 16;

function RowOddBtn({
  label,
  price,
  selected,
  locked: lockedProp,
  onClick,
  keepLabelOnMobile = false,
  boosted = false,
  originalPrice = null,
  compact = false,
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
  /** ZillaBoost applies to this cell — green tint + struck original. */
  boosted?: boolean;
  /** Pre-boost price, shown struck through beside the boosted one. */
  originalPrice?: number | null;
  /** Half-height variant (the draw row). See ROW_ODD_HEIGHT_COMPACT. */
  compact?: boolean;
}) {
  // A price at or below 1.00 can't return a profit, so the cell is
  // shown but not offered — greyed with an em dash, same as a suspended
  // outcome. Sub-1.01 prices above 1.00 (1.003 and friends) are
  // bettable and unaffected. Mirrors OddButton and the `authNum <= 1`
  // reject in POST /bets.
  const locked = lockedProp || (price != null && !isBettableOdds(price));
  // Boost styling yields to both selection and lock, exactly as
  // OddButton does: a picked cell must keep the accent affordance, and
  // a suspended one must not masquerade as a great price.
  const showBoost = boosted && !selected && !locked;
  // Compared at display precision — a boost that moves 1.003 -> 1.004 is
  // visible now that both render at 4dp.
  const showStrike =
    showBoost &&
    price != null &&
    originalPrice != null &&
    formatOddsDisplay(originalPrice) !== formatOddsDisplay(price);
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
    height: compact ? ROW_ODD_HEIGHT_COMPACT : ROW_ODD_HEIGHT,
    padding: compact ? "0 7px" : "0 9px",
    // Anchors the compact variant's tap-area pseudo-element.
    position: "relative",
    background: selected
      ? "var(--accent)"
      : showBoost
        ? "color-mix(in oklab, var(--positive, #16a34a) 12%, var(--surface-2))"
        : "var(--surface-2)",
    color: selected ? "var(--accent-fg)" : "var(--fg)",
    border: "1px solid",
    borderColor: selected
      ? "var(--accent)"
      : showBoost
        ? "var(--positive, #16a34a)"
        : "var(--border)",
    borderRadius: compact ? 6 : 8,
    cursor: locked ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    transition: "all 140ms var(--ease)",
    // Bumped from 0.5 → 0.65 so the price digits stay legible while
    // the cell still reads as "can't bet". 0.5 washed the dark text
    // into a faded gray that was hard to read on light theme.
    opacity: locked ? 0.65 : 1,
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
      data-compact={compact ? "true" : undefined}
      style={baseStyle}
    >
      <span
        className={keepLabelOnMobile ? "mono" : "mono oz-odd-label"}
        style={{
          fontSize: compact ? 9.5 : 10.5,
          lineHeight: 1,
          color: selected
            ? "color-mix(in oklab, var(--accent-fg) 70%, transparent)"
            : "var(--fg-muted)",
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      {showStrike && (
        <span
          className="mono tnum"
          style={{
            fontSize: compact ? 9 : 10,
            lineHeight: 1,
            color: "var(--fg-muted)",
            textDecoration: "line-through",
            letterSpacing: "-0.01em",
            // The row cell is only 30px tall (16 compact) and already
            // carries a label; let the struck original be the first
            // thing to go when the track is tight rather than squeezing
            // the price.
            flexShrink: 1,
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          {formatOddsDisplay(originalPrice!)}
        </span>
      )}
      <span
        className="mono tnum"
        style={{
          fontSize: compact ? 11 : 12.5,
          lineHeight: 1,
          // 700 so the digit punches through every state — selection
          // accent flip, odds-change flash, and locked dim all leave
          // the price strongly readable.
          fontWeight: 700,
          letterSpacing: "-0.01em",
          flexShrink: 0,
          // Pin per-state colour so the inherited `color` on the
          // button (which transitions over 140 ms on selection
          // swap) never washes the digit out mid-flip.
          color: showBoost
            ? "var(--positive, #16a34a)"
            : selected
              ? "var(--accent-fg)"
              : "var(--fg)",
        }}
      >
        {locked || price == null ? "—" : formatOddsDisplay(price)}
      </span>
    </button>
  );
}

