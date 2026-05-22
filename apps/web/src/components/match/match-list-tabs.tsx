"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { MatchRow, type ListMatch } from "./match-row";
import { I } from "@/components/ui/icons";
import {
  useLiveOddsForMatches,
  useLiveScoresForMatches,
  useLiveMatchStatusForMatches,
  useLiveMarketStatusForMatches,
  type LiveOddsTick,
  type LiveMatchStatusTick,
  type LiveMarketStatusTick,
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
  // Match-level lifecycle ticks — fan-out on the same odds:match:{id}
  // channel as ticks/scores, so this is zero additional subscriptions
  // when the per-row odds + scoreboard subscription is already up.
  // Used to drop the LIVE pill the moment Oddin reports the match
  // closed; without it the row stays at "live" until a hard refresh.
  const matchStatuses = useLiveMatchStatusForMatches(matchIds);
  // Per-market status — feed-ingester publishes a `marketStatus` frame
  // on every markets.status transition (suspend / settle / cancel /
  // resume). Listening here is what keeps the inline match-winner
  // odds button honest: Oddin frequently leaves `<outcome active="1">`
  // with the last price while the parent `<market status="-1">` is
  // suspended, so without merging the market-level status, the row
  // keeps showing a clickable price for a market the server will
  // reject at placement with `market_not_active` ("This market is
  // suspended"). Same shared socket as the odds / score / lifecycle
  // ticks above.
  const marketStatuses = useLiveMarketStatusForMatches(matchIds);
  // Match-room viewer counts for the "N watching" pill. REST poll
  // every 30s; the hook is keyed by the sorted matchIds so navigating
  // between list pages doesn't re-fetch unnecessarily.
  const viewerCounts = useViewerCountsForMatches(matchIds);

  // Merge live ticks AND scoreboards AND status into the SSR snapshot.
  // Each row's match-winner outcomes inherit the latest publishedOdds
  // / probability / active flag, the per-row mini scoreboard (series
  // + per-map cells) tracks every <sport_event_status> update, and
  // the match.status field flips on lifecycle transitions — all
  // without a page reload, so the row stays current as the game
  // progresses (and drops the LIVE pill the moment it ends).
  //
  // SSR + initial client paint: ticks / scores / statuses arrive via
  // useEffect → WebSocket, so on the first render they are empty
  // objects. In that state mergeMatchWithLive(m, {}, {}, {}, {}) returns
  // m by referential identity and the lookup Map's lookups all resolve
  // to the original input. The hasLiveData gate skips the 180-iteration
  // map + Map allocation for the no-data case — measurable v8 GC
  // pressure on the SSR process at 250+ concurrent storefront
  // requests (see docs/LOADTEST.md notes).
  const hasLiveData =
    Object.keys(ticks).length > 0 ||
    Object.keys(scores).length > 0 ||
    Object.keys(matchStatuses).length > 0 ||
    Object.keys(marketStatuses).length > 0;

  const merged = useMemo(
    () =>
      hasLiveData
        ? matches.map((m) =>
            mergeMatchWithLive(m, ticks, scores, matchStatuses, marketStatuses),
          )
        : matches,
    [matches, ticks, scores, matchStatuses, marketStatuses, hasLiveData],
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

// Overlay live odds AND live scoreboard AND match-level lifecycle
// status AND per-market status onto a server-rendered match. Returns a
// new object only when something actually changed, so React's
// referential equality short-circuits unaffected rows. `active=false`
// ticks null out the price; a market-status tick != 1 nulls every
// outcome on that market — MatchRow already locks the inline button
// when price is null, which is the same affordance LiveMarkets uses on
// the detail page.
function mergeMatchWithLive(
  m: ListMatchEnriched,
  ticks: Record<string, LiveOddsTick>,
  scores: Record<string, LiveScore>,
  statuses: Record<string, LiveMatchStatusTick>,
  marketStatuses: Record<string, LiveMarketStatusTick>,
): ListMatchEnriched {
  let next = m;

  const statusTick = statuses[m.id];
  if (statusTick && statusTick.status !== m.status) {
    next = { ...next, status: statusTick.status };
  }

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
    const marketStatusTick = marketStatuses[mw.marketId];
    // The catalog only ships matches whose match-winner market is at
    // status=1, so the only meaningful WS transition here is "anything
    // other than 1" → lock the row. Resume (back to 1) is handled
    // implicitly: subsequent odds ticks re-populate the price.
    const marketLocked =
      marketStatusTick != null && marketStatusTick.status !== 1;
    if (homeTick || awayTick || drawTick || marketLocked) {
      next = {
        ...next,
        matchWinner: {
          marketId: mw.marketId,
          home: homeTick
            ? {
                outcomeId: mw.home.outcomeId,
                price:
                  marketLocked || !homeTick.active
                    ? null
                    : homeTick.publishedOdds,
                probability: homeTick.probability ?? mw.home.probability ?? null,
              }
            : marketLocked
              ? { outcomeId: mw.home.outcomeId, price: null, probability: mw.home.probability ?? null }
              : mw.home,
          away: awayTick
            ? {
                outcomeId: mw.away.outcomeId,
                price:
                  marketLocked || !awayTick.active
                    ? null
                    : awayTick.publishedOdds,
                probability: awayTick.probability ?? mw.away.probability ?? null,
              }
            : marketLocked
              ? { outcomeId: mw.away.outcomeId, price: null, probability: mw.away.probability ?? null }
              : mw.away,
          draw:
            mw.draw && drawTick
              ? {
                  outcomeId: mw.draw.outcomeId,
                  price:
                    marketLocked || !drawTick.active
                      ? null
                      : drawTick.publishedOdds,
                  probability:
                    drawTick.probability ?? mw.draw.probability ?? null,
                }
              : mw.draw && marketLocked
                ? { outcomeId: mw.draw.outcomeId, price: null, probability: mw.draw.probability ?? null }
                : mw.draw ?? null,
        },
      };
    }
  }

  return next;
}
