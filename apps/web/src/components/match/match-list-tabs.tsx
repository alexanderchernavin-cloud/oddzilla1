"use client";

import { useMemo, useState, type ReactNode } from "react";
import { MatchRow, type ListMatch, type MatchListTab } from "./match-row";
import { useLiveOddsForMatches, type LiveOddsTick } from "@/lib/use-live-odds";

// A list match enriched server-side with the per-row metadata MatchRow
// needs. Functions can't cross the server/client boundary, so the
// surrounding page bakes these in instead of passing computed callbacks.
export interface ListMatchEnriched extends ListMatch {
  _sportSlug: string;
  _sportShort: string;
  _topConfigured: boolean;
}

// Page-level [Match | Top] tab strip for storefront list pages. The
// "Top" tab is only rendered when at least one match in view has the
// Top scope configured for its sport — otherwise the strip is hidden
// and Match-Winner odds render as before.
export function MatchListTabs({
  matches,
  groups,
}: {
  matches: ListMatchEnriched[];
  // Optional grouping — render headers between sections (e.g. Live /
  // Upcoming). When omitted we render a single flat list.
  groups?: Array<{ key: string; label: ReactNode; matches: ListMatchEnriched[] }>;
}) {
  const [tab, setTab] = useState<MatchListTab>("match");

  const anyTopConfigured = matches.some((m) => m._topConfigured);

  // Subscribe once for every match visible in this list. The shared
  // socket in use-live-odds coalesces all subscriptions, so this is one
  // physical connection regardless of how many list pages are mounted.
  const matchIds = useMemo(() => matches.map((m) => m.id), [matches]);
  const ticks = useLiveOddsForMatches(matchIds);

  // Merge live ticks into the SSR snapshot. Each row's match-winner and
  // (optional) Top market outcomes inherit the latest publishedOdds /
  // probability / active flag — so the inline 1/2 buttons reprice in
  // real time and lock when the outcome goes inactive instead of
  // staying frozen until the user reloads.
  const merged = useMemo(
    () => matches.map((m) => mergeMatchWithTicks(m, ticks)),
    [matches, ticks],
  );
  const mergedById = useMemo(() => {
    const map = new Map<string, ListMatchEnriched>();
    for (const m of merged) map.set(m.id, m);
    return map;
  }, [merged]);

  function renderRow(m: ListMatchEnriched) {
    const live = mergedById.get(m.id) ?? m;
    return (
      <MatchRow
        key={live.id}
        match={live}
        sportSlug={live._sportSlug}
        sportShort={live._sportShort}
        tab={tab}
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

  return (
    <>
      {anyTopConfigured ? (
        <div
          style={{
            display: "inline-flex",
            alignSelf: "flex-start",
            gap: 4,
            padding: 4,
            border: "1px solid var(--border)",
            borderRadius: 999,
            background: "var(--surface)",
            fontSize: 12,
          }}
        >
          {(["match", "top"] as MatchListTab[]).map((t) => {
            const active = t === tab;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className="mono"
                style={{
                  border: "none",
                  background: active ? "var(--fg)" : "transparent",
                  color: active ? "var(--bg)" : "var(--fg-muted)",
                  borderRadius: 999,
                  padding: "5px 12px",
                  fontSize: 11,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                {t === "match" ? "Match" : "Top"}
              </button>
            );
          })}
        </div>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>{body}</div>
    </>
  );
}

// Overlay live ticks onto a server-rendered match. Returns a new object
// only when something actually changed, so React's referential equality
// short-circuits unaffected rows. `active=false` ticks null out the
// price — MatchRow already locks the inline button when price is null,
// which is the same affordance LiveMarkets uses on the detail page.
function mergeMatchWithTicks(
  m: ListMatchEnriched,
  ticks: Record<string, LiveOddsTick>,
): ListMatchEnriched {
  let next = m;

  if (m.matchWinner) {
    const mw = m.matchWinner;
    const homeTick = ticks[`${mw.marketId}:${mw.home.outcomeId}`];
    const awayTick = ticks[`${mw.marketId}:${mw.away.outcomeId}`];
    if (homeTick || awayTick) {
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
        },
      };
    }
  }

  if (m.topMarket) {
    const top = m.topMarket;
    let touched = false;
    const outcomes = top.outcomes.map((o) => {
      const tick = ticks[`${top.marketId}:${o.outcomeId}`];
      if (!tick) return o;
      touched = true;
      return {
        ...o,
        publishedOdds: tick.active ? tick.publishedOdds : null,
        probability: tick.probability ?? o.probability ?? null,
      };
    });
    if (touched) {
      next = { ...next, topMarket: { ...top, outcomes } };
    }
  }

  return next;
}
