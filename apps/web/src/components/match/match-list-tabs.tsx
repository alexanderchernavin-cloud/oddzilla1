"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { MatchRow, type ListMatch } from "./match-row";
import { I } from "@/components/ui/icons";
import {
  useLiveOddsForMatches,
  useLiveScoresForMatches,
  type LiveOddsTick,
} from "@/lib/use-live-odds";
import { useSessionUserId } from "@/lib/session-user";
import { useViewerCountsForMatches } from "@/lib/use-viewer-counts";
import type { LiveScore } from "@/lib/live-score";

type ColCount = 1 | 2;

// Persisted in localStorage so the bettor's column preference survives
// navigation across the lobby / sport / live / upcoming pages. The CSS
// gate (`@media min-width: 2000px`) hides the toggle and forces a
// single column on narrower viewports even when the saved value is
// "2", so a returning user on a smaller monitor sees the layout they
// expect.
//
// Key is namespaced per signed-in bettor so two accounts sharing the
// same browser keep independent preferences — the user's "remembered
// per bettor" requirement. Anonymous viewers fall back to a single
// shared key.
const COLS_STORAGE_PREFIX = "oz:match-list-cols";
function colsStorageKey(userId: string | null): string {
  return userId ? `${COLS_STORAGE_PREFIX}:${userId}` : COLS_STORAGE_PREFIX;
}

// A list match enriched server-side with the per-row metadata MatchRow
// needs. Functions can't cross the server/client boundary, so the
// surrounding page bakes these in instead of passing computed callbacks.
export interface ListMatchEnriched extends ListMatch {
  _sportSlug: string;
  _sportShort: string;
}

// Wrapper around MatchRow that subscribes to live ticks/scoreboards and
// optionally groups the cards under section headers.
export function MatchListTabs({
  matches,
  groups,
}: {
  matches: ListMatchEnriched[];
  // Optional grouping — render headers between sections (e.g. Live /
  // Upcoming). When omitted we render a single flat list.
  groups?: Array<{ key: string; label: ReactNode; matches: ListMatchEnriched[] }>;
}) {
  // Subscribe once for every match visible in this list. The shared
  // socket in use-live-odds coalesces all subscriptions, so this is one
  // physical connection regardless of how many list pages are mounted.
  const matchIds = useMemo(() => matches.map((m) => m.id), [matches]);
  const ticks = useLiveOddsForMatches(matchIds);
  const scores = useLiveScoresForMatches(matchIds);
  // Match-room viewer counts for the "N watching" pill. REST poll
  // every 30s; the hook is keyed by the sorted matchIds so navigating
  // between list pages doesn't re-fetch unnecessarily.
  const viewerCounts = useViewerCountsForMatches(matchIds);

  // Merge live ticks AND scoreboards into the SSR snapshot. Each row's
  // match-winner outcomes inherit the latest publishedOdds / probability
  // / active flag, and the per-row mini scoreboard (series + per-map
  // cells) tracks every <sport_event_status> update without a page
  // reload — so the row stays current as the game progresses.
  //
  // SSR + initial client paint: ticks and scores arrive via useEffect →
  // WebSocket, so on the first render they are empty objects. In that
  // state mergeMatchWithLive(m, {}, {}) returns m by referential identity
  // and the lookup Map's lookups all resolve to the original input. The
  // hasLiveData gate skips the 180-iteration map + Map allocation for
  // the no-data case — measurable v8 GC pressure on the SSR process at
  // 250+ concurrent storefront requests (see docs/LOADTEST.md notes).
  const hasLiveData =
    Object.keys(ticks).length > 0 || Object.keys(scores).length > 0;

  const merged = useMemo(
    () =>
      hasLiveData
        ? matches.map((m) => mergeMatchWithLive(m, ticks, scores))
        : matches,
    [matches, ticks, scores, hasLiveData],
  );
  const mergedById = useMemo(() => {
    if (merged === matches) return null;
    const map = new Map<string, ListMatchEnriched>();
    for (const m of merged) map.set(m.id, m);
    return map;
  }, [merged, matches]);

  // Per-bettor column preference. Reading runs in an effect (and
  // re-runs when the signed-in user changes) so a login / logout
  // mid-session swaps the preference to the appropriate bettor's
  // saved value without a full page reload. SSR + initial paint show
  // the single-column default; the wide-viewport-only toggle means
  // the brief flip on hydration is invisible to anyone below 2000px
  // anyway.
  const userId = useSessionUserId();
  const [cols, setCols] = useState<ColCount>(1);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(colsStorageKey(userId));
      setCols(saved === "2" ? 2 : 1);
    } catch {
      // localStorage can throw under privacy / quota errors; fall
      // through to the single-column default in that case.
      setCols(1);
    }
  }, [userId]);
  function changeCols(c: ColCount) {
    setCols(c);
    try {
      window.localStorage.setItem(colsStorageKey(userId), String(c));
    } catch {
      // see note above
    }
  }

  function renderRow(m: ListMatchEnriched) {
    const live = mergedById?.get(m.id) ?? m;
    return (
      <MatchRow
        key={live.id}
        match={live}
        sportSlug={live._sportSlug}
        sportShort={live._sportShort}
        viewerCount={viewerCounts[live.id] ?? 0}
      />
    );
  }

  function renderCards(list: ListMatchEnriched[]) {
    return (
      <div className="oz-match-list-grid" data-cols={cols}>
        {list.map(renderRow)}
      </div>
    );
  }

  // First non-null section label hosts the cols toggle in the same row
  // — keeps the wide-viewport cols-toggle from claiming its own line
  // above the headers. When no group has a label we fall back to the
  // pre-refactor standalone position so the toggle still surfaces.
  const firstLabelIdx = groups
    ? groups.findIndex((g) => g.label != null)
    : -1;

  const body = groups
    ? groups.map((g, idx) => (
        <section
          key={g.key}
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          {idx === firstLabelIdx ? (
            <div className="oz-match-list-section-head">
              <div style={{ minWidth: 0, flex: 1 }}>{g.label}</div>
              <ColsToggle cols={cols} onChange={changeCols} />
            </div>
          ) : (
            g.label
          )}
          {renderCards(g.matches)}
        </section>
      ))
    : renderCards(merged);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {(!groups || firstLabelIdx === -1) && (
        <ColsToggle cols={cols} onChange={changeCols} />
      )}
      {body}
    </div>
  );
}

// Single / two-column toggle sitting on the right edge above the match
// list. Hidden via CSS below 2000px (covers QHD-at-125 %-scaling and
// up), where two cards per row would each be under ~450px wide and
// the layout starts to fight the scoreboard + odds buttons for space.
// The single-column flex stack is the default everywhere; the
// [data-cols="2"] grid only kicks in above the same breakpoint.
function ColsToggle({
  cols,
  onChange,
}: {
  cols: ColCount;
  onChange: (c: ColCount) => void;
}) {
  return (
    <div className="oz-match-list-cols" role="group" aria-label="Match list columns">
      <button
        type="button"
        className="oz-match-cols-btn"
        data-active={cols === 1 ? "true" : "false"}
        aria-pressed={cols === 1}
        aria-label="Single column"
        title="Single column"
        onClick={() => onChange(1)}
      >
        <I.Rows1 size={14} />
      </button>
      <button
        type="button"
        className="oz-match-cols-btn"
        data-active={cols === 2 ? "true" : "false"}
        aria-pressed={cols === 2}
        aria-label="Two columns"
        title="Two columns"
        onClick={() => onChange(2)}
      >
        <I.Columns2 size={14} />
      </button>
    </div>
  );
}

// Overlay live odds AND live scoreboard onto a server-rendered match.
// Returns a new object only when something actually changed, so React's
// referential equality short-circuits unaffected rows. `active=false`
// ticks null out the price — MatchRow already locks the inline button
// when price is null, which is the same affordance LiveMarkets uses on
// the detail page.
function mergeMatchWithLive(
  m: ListMatchEnriched,
  ticks: Record<string, LiveOddsTick>,
  scores: Record<string, LiveScore>,
): ListMatchEnriched {
  let next = m;

  const liveScore = scores[m.id];
  if (liveScore && liveScore !== m.liveScore) {
    next = { ...next, liveScore };
  }

  if (m.matchWinner) {
    const mw = m.matchWinner;
    const homeTick = ticks[`${mw.marketId}:${mw.home.outcomeId}`];
    const awayTick = ticks[`${mw.marketId}:${mw.away.outcomeId}`];
    const drawTick = mw.draw
      ? ticks[`${mw.marketId}:${mw.draw.outcomeId}`]
      : undefined;
    if (homeTick || awayTick || drawTick) {
      next = {
        ...next,
        matchWinner: {
          marketId: mw.marketId,
          home: homeTick
            ? {
                outcomeId: mw.home.outcomeId,
                price: homeTick.active ? homeTick.publishedOdds : null,
                probability: homeTick.probability ?? mw.home.probability ?? null,
              }
            : mw.home,
          away: awayTick
            ? {
                outcomeId: mw.away.outcomeId,
                price: awayTick.active ? awayTick.publishedOdds : null,
                probability: awayTick.probability ?? mw.away.probability ?? null,
              }
            : mw.away,
          draw:
            mw.draw && drawTick
              ? {
                  outcomeId: mw.draw.outcomeId,
                  price: drawTick.active ? drawTick.publishedOdds : null,
                  probability:
                    drawTick.probability ?? mw.draw.probability ?? null,
                }
              : mw.draw ?? null,
        },
      };
    }
  }

  return next;
}
