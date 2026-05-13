"use client";

import { useMemo, type ReactNode } from "react";
import { MatchRow, type ListMatch } from "./match-row";
import {
  useLiveOddsForMatches,
  useLiveScoresForMatches,
  type LiveOddsTick,
} from "@/lib/use-live-odds";
import { useViewerCountsForMatches } from "@/lib/use-viewer-counts";
import type { LiveScore } from "@/lib/live-score";

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

  const body = groups
    ? groups.map((g) => (
        <section key={g.key} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {g.label}
          {g.matches.map(renderRow)}
        </section>
      ))
    : merged.map(renderRow);

  return <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>{body}</div>;
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
