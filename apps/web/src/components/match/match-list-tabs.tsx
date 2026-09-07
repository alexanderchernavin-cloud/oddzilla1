"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  MatchRow,
  type ListLadderMarket,
  type ListMatch,
  type ListMatchOutcome,
} from "./match-row";
import { MatchTable } from "./match-table";
// Subpath, never the barrel — see packages/types/src/odds.ts.
import {
  isQuotableOutcomeOdds,
  quoteMarketBoost,
} from "@oddzilla/types/netwinstable";
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
import {
  useInitialListLayout,
  writeListLayoutCookie,
  type ListLayoutMode,
} from "@/lib/list-layout";
import type { LiveScore } from "@/lib/live-score";
import { useTranslations } from "@/lib/i18n";

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

/**
 * Which shape the match list takes.
 *
 *   "default" — one card per match (match-row.tsx): tournament strip,
 *               two team rows with crests, per-map scoreboard, trailing
 *               odds column. ~140px of page per fixture.
 *   "pro"     — the dense tournament-grouped table (match-table.tsx),
 *               modelled on fon.bet: one line per fixture under a
 *               tournament header carrying the column captions.
 *
 * Persisted the same way and for the same reason as the column count:
 * namespaced per signed-in bettor so two accounts sharing a browser
 * keep independent preferences, with a shared key for anonymous
 * viewers. "default" is the fallback for an unreadable / absent value,
 * so nobody is switched into a layout they never picked.
 *
 * Unlike the column count it is ALSO mirrored into a cookie
 * (lib/list-layout.tsx) so the server renders the chosen layout on the
 * first paint — a card-to-table flip after hydration is visible on
 * every screen, where the column toggle's equivalent flip only exists
 * above 2000px. localStorage stays the per-bettor source of truth; the
 * cookie is the SSR hint for this browser.
 */
type LayoutMode = ListLayoutMode;
const LAYOUT_STORAGE_PREFIX = "oz:match-list-layout";
function layoutStorageKey(userId: string | null): string {
  return userId ? `${LAYOUT_STORAGE_PREFIX}:${userId}` : LAYOUT_STORAGE_PREFIX;
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
  emptyMessage,
}: {
  matches: ListMatchEnriched[];
  // Optional grouping — render headers between sections (e.g. Live /
  // Upcoming). When omitted we render a single flat list.
  groups?: Array<{ key: string; label: ReactNode; matches: ListMatchEnriched[] }>;
  // Rendered when every row the server sent has since gone terminal
  // under an open page. The page's own empty copy can't reach that case
  // — it's derived from the SSR list — so the caller passes its already
  // translated string down. See `emptiedByEnding` below.
  emptyMessage?: ReactNode;
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

  // `layout` is read below; hoisted here because the merge depends on it.
  // Seeded from the cookie the server rendered with, so this first client
  // render matches the SSR markup — no hydration mismatch and no flip.
  const initialLayout = useInitialListLayout();
  const [layout, setLayout] = useState<LayoutMode>(initialLayout);
  const merged = useMemo(
    () =>
      hasLiveData
        ? matches.map((m) =>
            mergeMatchWithLive(
              m,
              ticks,
              scores,
              matchStatuses,
              marketStatuses,
              // Only the Pro table renders the handicap / total columns,
              // so only it needs their ticks merged. A live handicap
              // ladder ticks constantly; merging it under the card
              // layout would hand every such tick a fresh `match`
              // object for a row that shows nothing of it, re-rendering
              // cards the tick did not touch — the exact storm the
              // row-level memo exists to prevent. Default stays
              // byte-identical to its pre-Pro render behaviour.
              layout === "pro",
            ),
          )
        : matches,
    [matches, ticks, scores, matchStatuses, marketStatuses, hasLiveData, layout],
  );
  const mergedById = useMemo(() => {
    if (merged === matches) return null;
    const map = new Map<string, ListMatchEnriched>();
    for (const m of merged) map.set(m.id, m);
    return map;
  }, [merged, matches]);

  // Ids of matches that went TERMINAL while this list was mounted.
  //
  // A list page is a one-shot SSR snapshot — nothing re-fetches it (no
  // revalidate, no poll, no router.refresh) — and the groups are fixed
  // arrays the server computed. So without this, a tab left open on the
  // lobby slowly fills its "Live" section with finished games: the
  // matchStatus frame does arrive and mergeMatchWithLive flips
  // `match.status`, which drops the LIVE dot and the scoreboard
  // highlight, but the row itself stayed exactly where the server put
  // it, under a header that says Live.
  //
  // Terminal ONLY — deliberately not `suspended`. Every AMQP reconnect
  // runs FlushAndSuspendActiveCatalog, which moves every live match to
  // `suspended` for the seconds until Oddin's replay re-activates it
  // (invariant: suspend-before-recover). Dropping those rows would
  // blank the whole visible list on a routine feed blip, and since
  // nothing re-adds a row, it would stay blank until a reload — far
  // worse than a row that is marked non-live and priced at an em dash.
  //
  // The catalog never serves a terminal match either (`bookableWindow`
  // gates on status IN ('not_started','live')), so a match in here can
  // only have closed under an open page.
  const endedIds = useMemo(() => {
    if (merged === matches) return null;
    const ids = new Set<string>();
    for (const m of merged) {
      if (m.status === "closed" || m.status === "cancelled") ids.add(m.id);
    }
    return ids.size > 0 ? ids : null;
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
    try {
      // Only a real per-bettor value overrides the cookie-seeded state.
      // Forcing "default" on an absent value would undo the cookie for
      // a bettor who toggled under one account and is now viewing under
      // another (or logged out) — the flip this cookie exists to stop.
      const saved = window.localStorage.getItem(layoutStorageKey(userId));
      if (saved === "pro" || saved === "default") setLayout(saved);
    } catch {
      // Unreadable storage keeps whatever the cookie said.
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
  function changeLayout(l: LayoutMode) {
    setLayout(l);
    try {
      window.localStorage.setItem(layoutStorageKey(userId), l);
    } catch {
      // see note above
    }
    // The SSR hint for the next navigation; see lib/list-layout.tsx.
    writeListLayoutCookie(l);
  }

  function renderRow(m: ListMatchEnriched) {
    const live = mergedById?.get(m.id) ?? m;
    return (
      <MatchRow
        key={live.id}
        match={live}
        sportSlug={live._sportSlug}
        sportShort={live._sportShort}
      />
    );
  }

  // Filter by id, not by object identity: /live passes the same rows to
  // `matches` and to its single group through two separate
  // `.map(enrich)` calls, so the two arrays hold different objects for
  // the same match (which is also why renderRow looks the merged row up
  // by id rather than reading it off `m`).
  function shownOf(list: ListMatchEnriched[]): ListMatchEnriched[] {
    return endedIds ? list.filter((m) => !endedIds.has(m.id)) : list;
  }

  function renderList(list: ListMatchEnriched[]) {
    if (layout === "pro") {
      // The table needs the merged rows up front (it groups them before
      // it renders), where the card path resolves each row inside
      // renderRow. Same source either way — `mergedById` is null when
      // no live data has arrived, and the fallback is the SSR row.
      return (
        <MatchTable
          // `shownOf` first: a match that went terminal under this open
          // tab must leave the table exactly as it leaves the cards (#676).
          matches={shownOf(list).map((m) => mergedById?.get(m.id) ?? m)}
        />
      );
    }
    return (
      <div className="oz-match-list-grid" data-cols={cols}>
        {shownOf(list).map(renderRow)}
      </div>
    );
  }

  // Every row on the page ended under an open tab. Each page's own
  // "no matches" copy is computed server-side from the SSR list, so it
  // can't cover this — without `emptyMessage` the page would render its
  // section header over a void. Reachable on a narrow list well before
  // the lobby: one live tennis match on `/live?sport=tennis` finishing
  // is enough. `endedIds` is non-null only when a row actually went
  // terminal here, so this can never double up with the server's copy
  // (that one fires on an empty SSR list, where endedIds stays null).
  const emptiedByEnding =
    endedIds != null &&
    (groups
      ? groups.every((g) => shownOf(g.matches).length === 0)
      : shownOf(merged).length === 0);

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
              <ListControls
                cols={cols}
                onCols={changeCols}
                layout={layout}
                onLayout={changeLayout}
              />
            </div>
          ) : (
            g.label
          )}
          {renderList(g.matches)}
        </section>
      ))
    : renderList(merged);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {(!groups || firstLabelIdx === -1) && (
        <ListControls
          cols={cols}
          onCols={changeCols}
          layout={layout}
          onLayout={changeLayout}
        />
      )}
      {body}
      {emptiedByEnding && emptyMessage != null ? (
        <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
          {emptyMessage}
        </p>
      ) : null}
    </div>
  );
}

// The control cluster above every match list: layout first, then the
// column count.
//
// The column toggle is dropped entirely in Pro layout rather than
// disabled. It splits the CARD stack into two tracks; a dense table
// already fills the column's width and has nothing to split, so in Pro
// the control would be present, clickable, and do nothing — which reads
// as a bug rather than as "not applicable here".
function ListControls({
  cols,
  onCols,
  layout,
  onLayout,
}: {
  cols: ColCount;
  onCols: (c: ColCount) => void;
  layout: LayoutMode;
  onLayout: (l: LayoutMode) => void;
}) {
  return (
    <div className="oz-match-list-controls">
      <LayoutToggle layout={layout} onChange={onLayout} />
      {layout === "default" && <ColsToggle cols={cols} onChange={onCols} />}
    </div>
  );
}

// Default / Pro layout switch. Visible at every viewport width, unlike
// the column toggle beside it — the dense table is most valuable on a
// phone, where a card stack costs the most scrolling.
function LayoutToggle({
  layout,
  onChange,
}: {
  layout: LayoutMode;
  onChange: (l: LayoutMode) => void;
}) {
  const t = useTranslations("matchWidgets");
  return (
    <div
      className="oz-match-list-layout"
      role="group"
      aria-label={t("listLayout.aria")}
    >
      <button
        type="button"
        className="oz-match-cols-btn"
        data-active={layout === "default" ? "true" : "false"}
        aria-pressed={layout === "default"}
        aria-label={t("listLayout.default")}
        title={t("listLayout.default")}
        onClick={() => onChange("default")}
      >
        <I.LayoutCards size={14} />
      </button>
      <button
        type="button"
        className="oz-match-cols-btn"
        data-active={layout === "pro" ? "true" : "false"}
        aria-pressed={layout === "pro"}
        aria-label={t("listLayout.pro")}
        title={t("listLayout.pro")}
        onClick={() => onChange("pro")}
      >
        <I.LayoutTable size={14} />
      </button>
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
  const t = useTranslations("matchWidgets");
  return (
    <div className="oz-match-list-cols" role="group" aria-label={t("listCols.aria")}>
      <button
        type="button"
        className="oz-match-cols-btn"
        data-active={cols === 1 ? "true" : "false"}
        aria-pressed={cols === 1}
        aria-label={t("listCols.one")}
        title={t("listCols.one")}
        onClick={() => onChange(1)}
      >
        <I.Rows1 size={14} />
      </button>
      <button
        type="button"
        className="oz-match-cols-btn"
        data-active={cols === 2 ? "true" : "false"}
        aria-pressed={cols === 2}
        aria-label={t("listCols.two")}
        title={t("listCols.two")}
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
  mergeLadders: boolean,
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
      // RAW (pre-boost) price per outcome after this tick.
      //
      // The no-tick fallback deliberately reaches for the pre-boost
      // original rather than `o.price`: the SSR price IS the boosted
      // figure when a boost applied, and feeding that back into the
      // boost math below would compound the boost on every tick.
      const rawOf = (
        o: { price: string | null; boost?: { originalPrice: string } | null },
        tick: LiveOddsTick | undefined,
      ): string | null => {
        if (marketLocked) return null;
        if (tick) return tick.active ? tick.publishedOdds : null;
        return o.boost?.originalPrice ?? o.price;
      };
      const homeRaw = rawOf(mw.home, homeTick);
      const awayRaw = rawOf(mw.away, awayTick);
      const drawRaw = mw.draw ? rawOf(mw.draw, drawTick) : null;

      // Re-apply ZillaBoost over the ticked book. A match-winner market
      // is 1/2 (or 1/2/3), and the card subscribes to exactly those, so
      // the ticked set IS the whole book the key math needs.
      const hasRule =
        !!mw.boostRule ||
        (!!mw.boostSelections && Object.keys(mw.boostSelections).length > 0);
      const quoteOutcomes = (
        [
          [mw.home.outcomeId, homeRaw] as const,
          [mw.away.outcomeId, awayRaw] as const,
          ...(mw.draw ? [[mw.draw.outcomeId, drawRaw] as const] : []),
        ]
          .map(([outcomeId, raw]) => ({
            outcomeId,
            publishedOdds: raw != null ? Number(raw) : Number.NaN,
          }))
          .filter((o) => isQuotableOutcomeOdds(o.publishedOdds))
      );
      const cells =
        hasRule && quoteOutcomes.length >= 2
          ? quoteMarketBoost({
              outcomes: quoteOutcomes,
              marketWide: mw.boostRule ?? null,
              selections: mw.boostSelections
                ? new Map(Object.entries(mw.boostSelections))
                : null,
            })
          : [];
      const cellFor = (outcomeId: string) =>
        cells.find((c) => c.outcomeId === outcomeId);

      const merged = (
        o: ListMatchOutcome,
        raw: string | null,
        tick: LiveOddsTick | undefined,
      ): ListMatchOutcome => {
        const cell = raw != null ? cellFor(o.outcomeId) : undefined;
        return {
          outcomeId: o.outcomeId,
          price: cell ? cell.boostedOdds : raw,
          probability: tick?.probability ?? o.probability ?? null,
          boost: cell
            ? {
                ruleId: cell.ruleId,
                boostPct: cell.boostPct,
                endsAt: cell.endsAt,
                originalPrice: cell.originalOdds,
              }
            : null,
        };
      };

      next = {
        ...next,
        matchWinner: {
          ...mw,
          marketId: mw.marketId,
          home: merged(mw.home, homeRaw, homeTick),
          away: merged(mw.away, awayRaw, awayTick),
          draw: mw.draw ? merged(mw.draw, drawRaw, drawTick) : null,
        },
      };
    }
  }

  // Pro layout's handicap + total columns: the same tick + boost merge
  // the match winner gets above, on a two-outcome market.
  //
  // What this does NOT do is re-pick the main line as prices move: the
  // rung is fixed for the life of the SSR payload and only its two
  // prices update. Re-picking client-side would make a row's line jump
  // between rungs mid-session while the bettor is reading it, and the
  // other rungs' prices are not even subscribed — the card only
  // subscribes to the two outcomes it renders. The next page load picks
  // the line again.
  if (mergeLadders && next.ladders) {
    // Normalised to null before comparing: the API always sends both
    // keys, but the type admits `undefined`, and `mergeLadder(undefined)`
    // returns null — so an un-normalised compare would read
    // `null !== undefined` as a change and mint a new object on every
    // tick for a match with one ladder missing, breaking the row memo.
    const prevHandicap = next.ladders.handicap ?? null;
    const prevTotal = next.ladders.total ?? null;
    const nextHandicap = mergeLadder(prevHandicap, ticks, marketStatuses);
    const nextTotal = mergeLadder(prevTotal, ticks, marketStatuses);
    if (nextHandicap !== prevHandicap || nextTotal !== prevTotal) {
      next = {
        ...next,
        ladders: { handicap: nextHandicap, total: nextTotal },
      };
    }
  }

  return next;
}

// Overlays live prices onto one main-line market and re-applies its
// ZillaBoost over the ticked book — the match-winner merge above, for a
// two-outcome market. Returns the input by identity when nothing moved,
// so the row-level memo still short-circuits. A market-status tick off 1
// nulls both prices, which MatchTable renders as the same em dash a
// suspended outcome gets.
//
// The no-tick fallback reaches for the pre-boost original, not `price`:
// the SSR price IS the boosted figure when a boost applied, and feeding
// it back into the boost math would compound the boost on every tick.
function mergeLadder(
  ladder: ListLadderMarket | null | undefined,
  ticks: Record<string, LiveOddsTick>,
  marketStatuses: Record<string, LiveMarketStatusTick>,
): ListLadderMarket | null {
  if (!ladder) return null;
  const statusTick = marketStatuses[ladder.marketId];
  const locked = statusTick != null && statusTick.status !== 1;
  const firstTick = ticks[`${ladder.marketId}:${ladder.first.outcomeId}`];
  const secondTick = ticks[`${ladder.marketId}:${ladder.second.outcomeId}`];
  if (!locked && !firstTick && !secondTick) return ladder;

  const rawOf = (o: ListMatchOutcome, tick: LiveOddsTick | undefined) => {
    if (locked) return null;
    if (tick) return tick.active ? tick.publishedOdds : null;
    return o.boost?.originalPrice ?? o.price;
  };
  const firstRaw = rawOf(ladder.first, firstTick);
  const secondRaw = rawOf(ladder.second, secondTick);

  const hasRule =
    !!ladder.boostRule ||
    (!!ladder.boostSelections && Object.keys(ladder.boostSelections).length > 0);
  const quoteOutcomes = [
    [ladder.first.outcomeId, firstRaw] as const,
    [ladder.second.outcomeId, secondRaw] as const,
  ]
    .map(([outcomeId, raw]) => ({
      outcomeId,
      publishedOdds: raw != null ? Number(raw) : Number.NaN,
    }))
    .filter((o) => isQuotableOutcomeOdds(o.publishedOdds));
  const cells =
    hasRule && quoteOutcomes.length >= 2
      ? quoteMarketBoost({
          outcomes: quoteOutcomes,
          marketWide: ladder.boostRule ?? null,
          selections: ladder.boostSelections
            ? new Map(Object.entries(ladder.boostSelections))
            : null,
        })
      : [];

  const merged = (
    o: ListMatchOutcome,
    raw: string | null,
    tick: LiveOddsTick | undefined,
  ): ListMatchOutcome => {
    const cell = raw != null ? cells.find((c) => c.outcomeId === o.outcomeId) : undefined;
    return {
      outcomeId: o.outcomeId,
      price: cell ? cell.boostedOdds : raw,
      probability: tick?.probability ?? o.probability ?? null,
      boost: cell
        ? {
            ruleId: cell.ruleId,
            boostPct: cell.boostPct,
            endsAt: cell.endsAt,
            originalPrice: cell.originalOdds,
          }
        : null,
    };
  };
  return {
    ...ladder,
    first: merged(ladder.first, firstRaw, firstTick),
    second: merged(ladder.second, secondRaw, secondTick),
  };
}
