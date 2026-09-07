"use client";

/**
 * Pro Layout — the dense, tournament-grouped match table.
 *
 * The Default layout gives every match a card: a tournament strip, two
 * team rows with crests, a per-map scoreboard and a trailing odds
 * column. That is ~140px of page per fixture, which is right when a
 * bettor is browsing a handful of esports matches and wrong when the
 * Fonbet line puts nineteen Premier League fixtures in front of them.
 *
 * This is the other shape, modelled on fon.bet's own match list: one
 * line per fixture, grouped under a tournament header that carries the
 * column captions, with three market groups — Result, Handicap, Total —
 * in columns that line up down the whole group. Measured on one 1500px
 * viewport: Default showed 3 fixtures, Pro shows 11.
 *
 * Three things about the columns are worth knowing before editing:
 *
 *  1. **One shared width per cell class.** `--oz-pro-cell-w` and friends
 *     are declared on `.oz-pro-group` and read by BOTH the header
 *     captions and the row cells, so alignment is structural rather
 *     than maintained. The header and the row render the SAME group
 *     blocks in the same order, for the same reason.
 *  2. **Groups are hidden by container width, in CSS, via `data-group`.**
 *     Header and cells carry the same attribute, so they can never
 *     disappear independently and there is no SSR/client mismatch to
 *     get wrong. A narrow list shows Result only.
 *  3. **The main handicap / total rung is the SERVER's pick** — which
 *     market types count and which rung is "main" live in
 *     `@oddzilla/types/list-markets`. The client never re-derives
 *     either, and deliberately does not re-pick the line as prices
 *     move; see the note on `mergeLadder` in match-list-tabs.tsx.
 */

import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, MouseEvent } from "react";
import { clientApi } from "@/lib/api-client";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { LiveDot, TeamMark } from "@/components/ui/primitives";
import { TierMark, isFeaturedTier } from "@/components/ui/tier-mark";
import { I } from "@/components/ui/icons";
import { useBetSlip } from "@/lib/bet-slip";
import { servingSide } from "@/lib/live-score";
import { useOddsFlash } from "@/lib/use-odds-flash";
import { useTranslations } from "@/lib/i18n";
import {
  matchWinnerSelection,
  type MatchWinnerSide,
} from "@/lib/match-winner-selection";
import { ServeMark } from "./serve-mark";
import { LiveMeta } from "./live-meta";
import { LocalDateTime } from "./local-datetime";
import { teamTag, type ListLadderMarket, type ListMatch, type ListMatchOutcome } from "./match-row";
// Value imports via subpaths, never the barrel — see the note in
// packages/types/src/odds.ts.
import { formatOddsDisplay, isBettableOdds } from "@oddzilla/types/odds";
import { handicapLineForSide } from "@oddzilla/types/list-markets";
import { formatEventTitle } from "@oddzilla/types/custom-events";
import type { SlipSelection } from "@oddzilla/types";

// Structurally what MatchListTabs' `ListMatchEnriched` is. Declared here
// rather than imported so this module does not depend on the one that
// renders it.
type TableMatch = ListMatch & { _sportSlug: string; _sportShort: string };

export type LadderKind = "handicap" | "total";
/** Reports a rung the bettor picked from a row's line stepper. */
export type ChooseLine = (matchId: string, kind: LadderKind, rung: ListLadderMarket) => void;
/** Wire shape of GET /catalog/matches/:id/ladders. */
interface LaddersResponse {
  handicap: ListLadderMarket[];
  total: ListLadderMarket[];
}

// ── Column model ────────────────────────────────────────────────────

type GroupKind = "result" | "handicap" | "total";

interface ResultColumn {
  label: string;
  side: MatchWinnerSide;
}

/**
 * Which result columns the LIST shows — computed once over every fixture
 * on the page, not per tournament group.
 *
 * It was per group for a day, on the reasoning that a tennis group need
 * not carry a dead "X". But the clock, score and team names sit to the
 * LEFT of the odds track, and a track that is one cell narrower on one
 * group slides all of them right by a cell there: a football match whose
 * 1X2 came back two-way at half time (draw suspended) put its clock 46px
 * off the rows above and below it (operator, 2026-09-07). Columns are
 * the widest any row needs; a row without the market shows `—`, which is
 * fon.bet's rule as well. Read off the SSR market STRUCTURE rather than
 * off prices, so a live tick can never add or remove a column
 * mid-session.
 *
 * The captions are the betting symbols 1 / X / 2, deliberately NOT
 * translated: they are the same three characters on every book in every
 * language (fon.bet prints them under an English AND a Russian line),
 * and "X" is what the match page's draw button already says.
 */
const RESULT_2WAY: ResultColumn[] = [
  { label: "1", side: "home" },
  { label: "2", side: "away" },
];
const RESULT_3WAY: ResultColumn[] = [
  { label: "1", side: "home" },
  { label: "X", side: "draw" },
  { label: "2", side: "away" },
];
function resultColumnsFor(matches: TableMatch[]): ResultColumn[] {
  return matches.some((m) => !isQuestion(m) && m.matchWinner?.draw != null)
    ? RESULT_3WAY
    : RESULT_2WAY;
}

/**
 * An operator-authored event that presents as a question rather than a
 * fixture ("Dima and Nastya to unite again"). The Default card replaces
 * its match-up with the event's markets for exactly the reason the Pro
 * row must not print `Home — Away` for it: its two "sides" are answers,
 * and captioning their prices 1 / X / 2 would tell a bettor which one
 * is playing at home. Such a row shows its title and leads to the match
 * page, and is left out of the column derivation so a group made of
 * questions gets no odds captions at all.
 */
function isQuestion(m: TableMatch): boolean {
  return !!m.inlineMarkets && m.inlineMarkets.length > 0;
}

/**
 * Which market groups the LIST renders — again over every fixture on the
 * page, for the same alignment reason as the result columns. A page
 * where no row quotes a handicap (an esports list) gets no handicap
 * column; a page where some do gets it on every row, dashed where a
 * fixture lacks it. The groups that DO appear are then hidden or shown
 * by container width in CSS: this decides "is there anything here", the
 * stylesheet decides "is there room for it".
 *
 * Returns one of four module-constant arrays, never a fresh one. The
 * result is a prop on every memoized ProRow, and MatchTable re-renders
 * on every live tick of every visible match — a new array per call
 * would fail the memo's shallow compare on every row on every tick,
 * which is precisely the render storm the memo exists to stop (and the
 * first cut of this function did exactly that).
 */
const GROUPS_NONE: GroupKind[] = [];
const GROUPS_R: GroupKind[] = ["result"];
const GROUPS_RH: GroupKind[] = ["result", "handicap"];
const GROUPS_RT: GroupKind[] = ["result", "total"];
const GROUPS_RHT: GroupKind[] = ["result", "handicap", "total"];
function marketGroupsFor(matches: TableMatch[]): GroupKind[] {
  const fixtures = matches.filter((m) => !isQuestion(m));
  // A group made entirely of questions has no fixture to caption: no
  // `1 / 2` over rows that carry no cells. Measured on /sport/custom,
  // where the first cut printed the captions over two empty tracks.
  if (fixtures.length === 0) return GROUPS_NONE;
  const h = fixtures.some((m) => m.ladders?.handicap != null);
  const t = fixtures.some((m) => m.ladders?.total != null);
  return h ? (t ? GROUPS_RHT : GROUPS_RH) : t ? GROUPS_RT : GROUPS_R;
}

// ── Grouping ────────────────────────────────────────────────────────

interface TournamentGroup {
  key: string;
  sportSlug: string;
  sportShort: string;
  tournamentId: number;
  tournamentName: string;
  riskTier: number | null;
  liveCount: number;
  matches: TableMatch[];
}

/**
 * Buckets a list into tournament groups, preserving server order.
 *
 * Order matters and is not ours to invent: the catalog sorts one
 * tier-ordered region at the top of every list (see `matchListOrder`),
 * and re-sorting groups here — alphabetically, by size, by tier — would
 * undo it exactly the way the sport page's status split did on
 * 2026-09-06. Groups therefore appear in the order their FIRST match
 * does, and rows keep their order inside a group.
 *
 * Keyed by (sport, tournament) rather than tournament alone: ids are
 * unique across sports today, but a cross-sport lobby list is precisely
 * where a collision would render two different competitions as one.
 *
 * One tournament CAN head two groups on the same page, and that is not
 * a grouping bug: MatchListTabs renders one table per section, and the
 * sport page's sections are the tier-hoisted region and everything
 * after it (see `featured` in sport/[slug]/page.tsx). A league with one
 * fixture inside its tier's hoist window and one outside is split
 * across both — exactly as its CARDS already are, each carrying its own
 * tournament strip. Merging across sections would mean re-ordering the
 * page, which is the one thing this function must not do.
 */
function groupByTournament(matches: TableMatch[]): TournamentGroup[] {
  const out: TournamentGroup[] = [];
  const index = new Map<string, TournamentGroup>();
  for (const m of matches) {
    const key = `${m._sportSlug}:${m.tournament.id}`;
    let g = index.get(key);
    if (!g) {
      g = {
        key,
        sportSlug: m._sportSlug,
        sportShort: m._sportShort,
        tournamentId: m.tournament.id,
        tournamentName: m.tournament.name,
        riskTier: m.tournament.riskTier ?? null,
        liveCount: 0,
        matches: [],
      };
      index.set(key, g);
      out.push(g);
    }
    if (m.status === "live") g.liveCount += 1;
    g.matches.push(m);
  }
  return out;
}

// ── Table ───────────────────────────────────────────────────────────

export function MatchTable({
  matches,
  onChooseLine,
}: {
  matches: TableMatch[];
  /** Stable callback (memoized by the parent) so row memos hold. */
  onChooseLine: ChooseLine;
}) {
  const groups = useMemo(() => groupByTournament(matches), [matches]);
  // Page-wide, so every group's odds track is the same width and the
  // clock / score / names column lines up down the whole list.
  const resultColumns = useMemo(() => resultColumnsFor(matches), [matches]);
  const marketGroups = useMemo(() => marketGroupsFor(matches), [matches]);
  return (
    <div className="oz-pro-table">
      {groups.map((g) => (
        <ProGroup
          key={g.key}
          group={g}
          resultColumns={resultColumns}
          marketGroups={marketGroups}
          onChooseLine={onChooseLine}
        />
      ))}
    </div>
  );
}

interface LadderLabels {
  handicap: string;
  total: string;
  over: string;
  under: string;
  chooseLine: string;
  mainLine: string;
}

/** Caption for one cell position, with the width class it must match. */
interface Caption {
  text: string;
  variant?: "wide" | "line" | "step";
}

function ProGroup({
  group,
  resultColumns,
  marketGroups: pageGroups,
  onChooseLine,
}: {
  group: TournamentGroup;
  resultColumns: ResultColumn[];
  marketGroups: GroupKind[];
  onChooseLine: ChooseLine;
}) {
  const tMatch = useTranslations("match");
  const tCommon = useTranslations("common");
  const tw = useTranslations("matchWidgets");
  // A group made only of questions still carries no odds track at all:
  // its rows have no cells, so captions over them would head nothing.
  const marketGroups = useMemo(
    () => (group.matches.every(isQuestion) ? GROUPS_NONE : pageGroups),
    [group.matches, pageGroups],
  );
  const featured = isFeaturedTier(group.riskTier);

  const labels: LadderLabels = useMemo(
    () => ({
      handicap: tw("listMarkets.handicap"),
      total: tw("listMarkets.total"),
      over: tw("listMarkets.over"),
      under: tw("listMarkets.under"),
      chooseLine: tw("listMarkets.chooseLine"),
      mainLine: tw("listMarkets.mainLine"),
    }),
    [tw],
  );

  const captionsFor = (kind: GroupKind): Caption[] => {
    if (kind === "result") return resultColumns.map((c) => ({ text: c.label }));
    if (kind === "handicap") {
      return [
        { text: tw("listMarkets.handicapHome"), variant: "wide" },
        // The ladder stepper sits between the two sides in every row, so
        // the header has to hold its slot or the group is narrower here
        // than below and every column to the LEFT of it — the 1 / X / 2
        // captions included — stops lining up with its own cells. A
        // spacer, not a label: the control names nothing.
        { text: "", variant: "step" },
        { text: tw("listMarkets.handicapAway"), variant: "wide" },
      ];
    }
    return [
      { text: tw("listMarkets.totalShort"), variant: "line" },
      { text: tw("listMarkets.overShort") },
      { text: tw("listMarkets.underShort") },
    ];
  };

  const groupLabel = (kind: GroupKind): string =>
    kind === "result"
      ? tMatch("matchWinner")
      : kind === "handicap"
        ? labels.handicap
        : labels.total;

  return (
    <section
      className="oz-pro-group"
      data-featured={featured ? "true" : undefined}
    >
      <div className="oz-pro-head">
        <Link
          href={`/sport/${group.sportSlug}?tournament=${group.tournamentId}`}
          className="oz-pro-head-name"
        >
          <SportGlyph sport={group.sportSlug} size={13} />
          <span className="mono oz-pro-head-sport">{group.sportShort}</span>
          {featured && (
            <TierMark
              tier={group.riskTier}
              size={11}
              label={tMatch("topTournamentTitle")}
            />
          )}
          <span className="oz-pro-head-title">{group.tournamentName}</span>
          {group.liveCount > 0 && (
            <span className="oz-pro-head-live">
              <LiveDot size={5} /> {group.liveCount}
            </span>
          )}
        </Link>
        {marketGroups.map((kind) => (
          <div
            key={kind}
            className="oz-pro-odds"
            data-group={kind}
            role="presentation"
            aria-label={groupLabel(kind)}
          >
            {captionsFor(kind).map((c, i) => (
              <span
                key={i}
                className="mono oz-pro-collabel"
                data-variant={c.variant}
              >
                {c.text}
              </span>
            ))}
          </div>
        ))}
        <span className="oz-pro-more" aria-hidden="true" />
      </div>
      <div className="oz-pro-rows">
        {group.matches.map((m) => (
          <ProRow
            key={m.id}
            match={m}
            resultColumns={resultColumns}
            marketGroups={marketGroups}
            drawLabel={tCommon("draw")}
            labels={labels}
            onChooseLine={onChooseLine}
          />
        ))}
      </div>
    </section>
  );
}

// Memoized for the same reason MatchRow is: MatchListTabs holds five
// aggregated live-state objects, so any tick on any visible match
// re-renders the list. mergeMatchWithLive returns a referentially
// identical `match` for every row a tick did not touch — but only a
// memoized row can take advantage of it. `resultColumns`,
// `marketGroups` and `labels` are all memoized per group.
const ProRow = memo(function ProRow({
  match,
  resultColumns,
  marketGroups,
  drawLabel,
  labels,
  onChooseLine,
}: {
  match: TableMatch;
  resultColumns: ResultColumn[];
  marketGroups: GroupKind[];
  drawLabel: string;
  labels: LadderLabels;
  onChooseLine: ChooseLine;
}) {
  const slip = useBetSlip();
  const tMatch = useTranslations("match");
  const marketLabel = tMatch("matchWinner");
  const isLive = match.status === "live";
  const serving = servingSide(match.liveScore ?? null, isLive);

  function toggle(selection: SlipSelection | null) {
    if (!selection) return;
    if (slip.has(selection.marketId, selection.outcomeId)) {
      slip.remove(selection.marketId, selection.outcomeId);
    } else {
      slip.add(selection);
    }
  }

  function pickResult(side: MatchWinnerSide, e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    toggle(
      matchWinnerSelection(match, side, match._sportSlug, {
        marketLabel,
        drawLabel,
      }),
    );
  }

  function pickLadder(
    ladder: ListLadderMarket,
    outcome: ListMatchOutcome,
    outcomeLabel: string,
    ladderMarketLabel: string,
    e: MouseEvent<HTMLButtonElement>,
  ) {
    e.preventDefault();
    e.stopPropagation();
    if (!outcome.price) return;
    toggle({
      matchId: match.id,
      marketId: ladder.marketId,
      outcomeId: outcome.outcomeId,
      odds: outcome.price,
      probability: outcome.probability ?? undefined,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      // BOTH halves carry the line, because none of the surfaces that
      // read them back — the slip, bet history, a copied community
      // ticket — shows the column caption that would otherwise say
      // which rung this was. A leg reading "Handicap / Getafe" at 1.70
      // is not identifiable; "Handicap -1 / Getafe -1" is. Same lesson
      // as the sub-event prefix on `market.name` (2026-09-05).
      marketLabel: ladderMarketLabel,
      outcomeLabel,
      sportSlug: match._sportSlug,
      // Safe for the same reason the match-winner path stamps it: the
      // null-price guard above already rejected the suspended case.
      active: true,
      // Same load-bearing field the match-winner selection carries (see
      // match-winner-selection.ts): without it POST /bets prices the leg
      // from the raw book, and since a typical boost sits inside the 5%
      // drift tolerance the bet is silently ACCEPTED at the lower price
      // rather than rejected.
      customBoostRuleId: outcome.boost?.ruleId,
    });
  }

  const resultOutcome = (side: MatchWinnerSide): ListMatchOutcome | null => {
    const mw = match.matchWinner;
    if (!mw) return null;
    return side === "draw" ? mw.draw ?? null : mw[side];
  };

  const handicap = match.ladders?.handicap ?? null;
  const total = match.ladders?.total ?? null;
  const question = isQuestion(match);

  function renderResult() {
    return resultColumns.map((c) => {
      const o = resultOutcome(c.side);
      return (
        <ProOddCell
          key={c.side}
          label={c.label}
          outcome={o}
          selected={
            match.matchWinner != null &&
            o != null &&
            slip.has(match.matchWinner.marketId, o.outcomeId)
          }
          onClick={(e) => pickResult(c.side, e)}
        />
      );
    });
  }

  function renderHandicap() {
    const cells = ([false, true] as const).map((isAway) => {
      const o = handicap ? (isAway ? handicap.second : handicap.first) : null;
      const line = handicap ? handicapLineForSide(handicap.line, isAway) : null;
      const team = isAway ? match.awayTeam : match.homeTeam;
      return (
        <ProOddCell
          key={isAway ? "away" : "home"}
          label={`${labels.handicap} ${line ?? ""}`.trim()}
          outcome={o}
          line={line}
          wide
          selected={
            handicap != null && o != null && slip.has(handicap.marketId, o.outcomeId)
          }
          onClick={(e) => {
            if (!handicap || !o) return;
            pickLadder(
              handicap,
              o,
              `${team} ${line ?? ""}`.trim(),
              `${labels.handicap} ${handicap.line}`,
              e,
            );
          }}
        />
      );
    });
    // The stepper sits between the two sides, as fon.bet draws it —
    // it is one line for both, so it belongs to neither cell.
    return [
      cells[0],
      <LinePicker
        key="pick"
        matchId={match.id}
        kind="handicap"
        current={handicap}
        labels={labels}
        homeTeam={match.homeTeam}
        awayTeam={match.awayTeam}
        onChoose={onChooseLine}
      />,
      cells[1],
    ];
  }

  function renderTotal() {
    return [
      <LinePicker
        key="line"
        matchId={match.id}
        kind="total"
        current={total}
        labels={labels}
        homeTeam={match.homeTeam}
        awayTeam={match.awayTeam}
        onChoose={onChooseLine}
      />,
      ...([false, true] as const).map((isUnder) => {
        const o = total ? (isUnder ? total.second : total.first) : null;
        const word = isUnder ? labels.under : labels.over;
        return (
          <ProOddCell
            key={isUnder ? "under" : "over"}
            label={`${word} ${total?.line ?? ""}`.trim()}
            outcome={o}
            selected={total != null && o != null && slip.has(total.marketId, o.outcomeId)}
            onClick={(e) => {
              if (!total || !o) return;
              pickLadder(
                total,
                o,
                `${word} ${total.line}`,
                `${labels.total} ${total.line}`,
                e,
              );
            }}
          />
        );
      }),
    ];
  }

  return (
    <div className="oz-pro-row" data-live={isLive ? "true" : undefined}>
      {/* Stretched link: the anchor carries the team names and its
          ::after covers the whole row, so the entire strip navigates
          without nesting the price buttons inside an <a> (which is what
          the Default card does, and is invalid HTML). The buttons sit
          above it on z-index. */}
      <Link href={`/match/${match.id}`} className="oz-pro-link">
        {question ? (
          // Same title the Default card prints above the event's
          // markets. No serve mark, no separator: nothing is playing
          // anything.
          <span className="oz-pro-teams">
            <span className="oz-pro-team">
              {formatEventTitle(match.homeTeam, match.awayTeam)}
            </span>
          </span>
        ) : (
          <span className="oz-pro-teams">
            {/* Crests as on the card, sized to the 34px row. TeamMark
                renders nothing without a picture, so a side with no
                logo is its name alone — no slot, no monogram — and the
                name sits in its own span so a crest never eats the
                ellipsis (operator, 2026-09-07). */}
            <span className="oz-pro-team">
              <TeamMark
                tag={teamTag(match.homeTeam)}
                size={16}
                logoUrl={match.homeLogoUrl ?? null}
                name={match.homeTeam}
              />
              <span className="oz-pro-teamname">{match.homeTeam}</span>
              {serving === "home" ? <ServeMark /> : null}
            </span>
            <span className="oz-pro-vs" aria-hidden="true">
              —
            </span>
            <span className="oz-pro-team">
              <TeamMark
                tag={teamTag(match.awayTeam)}
                size={16}
                logoUrl={match.awayLogoUrl ?? null}
                name={match.awayTeam}
              />
              <span className="oz-pro-teamname">{match.awayTeam}</span>
              {serving === "away" ? <ServeMark /> : null}
            </span>
          </span>
        )}
        <span className="oz-pro-meta">
          {isLive ? (
            <LiveMeta liveScore={match.liveScore ?? null} />
          ) : match.scheduledAt ? (
            <span className="mono oz-pro-time">
              <LocalDateTime iso={match.scheduledAt} mode="row" />
            </span>
          ) : null}
        </span>
      </Link>

      {/* A question carries no price cells: its answers are on the
          match page, one click away, where they can be labelled as
          what they are. Putting its match-winner pair under the 1 / 2
          captions here would caption an answer as the home team. */}
      {question
        ? null
        : marketGroups.map((kind) => (
            <div key={kind} className="oz-pro-odds" data-group={kind}>
              {kind === "result"
                ? renderResult()
                : kind === "handicap"
                  ? renderHandicap()
                  : renderTotal()}
            </div>
          ))}

      <span className="oz-pro-more" aria-hidden="true">
        <I.Chev size={13} />
      </span>
    </div>
  );
});

/**
 * fon.bet's ⇅: choose which rung of a match's handicap or total ladder
 * the row shows.
 *
 * For a total the control IS the line chip (one line shared by two
 * prices); for a handicap it is a narrow stepper between the two sides.
 * Opening it fetches the match's whole ladder — every full-match rung,
 * priced for this viewer, in the row's own wire shape — and lists the
 * rungs as fon.bet does, current one marked, main line named. Picking
 * one reports up to MatchListTabs, which stores it above the live merge
 * so ticks and boosts keep pricing it; the picker itself holds only the
 * open / loading / fetched state of one popover.
 *
 * Portal onto <body>: the tournament group clips overflow to keep its
 * rounded corners, so a panel drawn inside the row would be cut at the
 * group's edge. Fixed position under the trigger, closed by Escape,
 * outside click, scroll or resize — the same discipline Bet Assist's
 * panel keeps. Inside the popover a row selects; betting stays on the
 * main row's cells, so there is one place a price is clicked.
 *
 * Fetched on open every time rather than cached: one small request, and
 * a ladder shown even a minute stale on a live match would quote rungs
 * the book has moved off.
 */
function LinePicker({
  matchId,
  kind,
  current,
  labels,
  homeTeam,
  awayTeam,
  onChoose,
}: {
  matchId: string;
  kind: LadderKind;
  current: ListLadderMarket | null;
  labels: LadderLabels;
  homeTeam: string;
  awayTeam: string;
  onChoose: ChooseLine;
}) {
  const [open, setOpen] = useState(false);
  const [rungs, setRungs] = useState<ListLadderMarket[] | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setRungs(null);
  }, []);

  function toggle(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (open) {
      close();
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setAnchor({ top: r.bottom + 4, left: r.left });
    setOpen(true);
    clientApi<LaddersResponse>(`/catalog/matches/${matchId}/ladders`)
      .then((res) => setRungs(res[kind]))
      .catch(() => setRungs([]));
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  const isTotal = kind === "total";
  // Whatever the row currently shows is what is "current" — the server's
  // main line or a previous pick. Marked by market id, which IS the rung.
  const currentId = current?.marketId ?? null;

  const panel =
    open && anchor
      ? createPortal(
          <div
            ref={panelRef}
            className="oz-pro-linepop"
            role="listbox"
            aria-label={labels.chooseLine}
            style={{ top: anchor.top, left: anchor.left }}
          >
            {rungs == null ? (
              <div className="oz-pro-linepop-empty">…</div>
            ) : rungs.length === 0 ? (
              <div className="oz-pro-linepop-empty">—</div>
            ) : (
              rungs.map((r) => {
                const isCurrent = r.marketId === currentId;
                const p1 = r.first.price != null ? formatOddsDisplay(Number(r.first.price)) : "—";
                const p2 = r.second.price != null ? formatOddsDisplay(Number(r.second.price)) : "—";
                return (
                  <button
                    key={r.marketId}
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    className="oz-pro-linepop-row mono tnum"
                    data-current={isCurrent ? "true" : undefined}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onChoose(matchId, kind, r);
                      close();
                    }}
                  >
                    {isTotal ? (
                      <>
                        <span className="oz-pro-linepop-line">{r.line}</span>
                        <span className="oz-pro-linepop-price">{p1}</span>
                        <span className="oz-pro-linepop-price">{p2}</span>
                      </>
                    ) : (
                      <>
                        <span className="oz-pro-linepop-line">
                          {handicapLineForSide(r.line, false)}
                        </span>
                        <span className="oz-pro-linepop-price">{p1}</span>
                        <span className="oz-pro-linepop-line">
                          {handicapLineForSide(r.line, true)}
                        </span>
                        <span className="oz-pro-linepop-price">{p2}</span>
                      </>
                    )}
                  </button>
                );
              })
            )}
          </div>,
          document.body,
        )
      : null;

  const title = `${labels.chooseLine} — ${homeTeam} — ${awayTeam}`;

  if (isTotal) {
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          className="mono tnum oz-pro-linecell"
          data-open={open ? "true" : undefined}
          disabled={!current}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={title}
          title={labels.chooseLine}
          onClick={toggle}
        >
          <span>{current ? current.line : "—"}</span>
          <I.UpDown size={9} />
        </button>
        {panel}
      </>
    );
  }
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="oz-pro-stepper"
        data-open={open ? "true" : undefined}
        disabled={!current}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={title}
        title={labels.chooseLine}
        onClick={toggle}
      >
        <I.UpDown size={10} />
      </button>
      {panel}
    </>
  );
}


/**
 * One price cell.
 *
 * Same states as the Default layout's RowOddBtn — selected, boosted,
 * locked — and the same rules behind them, because a bettor must not be
 * offered a cell here that the card would grey out. In particular the
 * sub-1.01 lock is `isBettableOdds`, mirroring the `authNum <= 1` reject
 * in POST /bets.
 *
 * `line` prints the handicap this side is playing beside its price,
 * which is what makes two identically-captioned columns readable. It is
 * dropped while locked: an em dash needs no line, and the pair would
 * read as a price.
 *
 * The one thing this drops is the struck-through pre-boost price: the
 * cell is ~50px wide and already carries a 12px number. A boost shows as
 * the green tint plus an upward caret, with the original in the tooltip
 * — the card layout remains the place that spells it out. Result and
 * ladder cells alike: every priced market on the card is boosted by the
 * same server quoter the match page's prices come from.
 */
function ProOddCell({
  label,
  outcome,
  selected,
  onClick,
  line = null,
  wide = false,
}: {
  label: string;
  outcome: ListMatchOutcome | null;
  selected: boolean;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  line?: string | null;
  wide?: boolean;
}) {
  const price = outcome?.price != null ? Number(outcome.price) : null;
  const locked = price == null || !isBettableOdds(price);
  const boost = outcome?.boost ?? null;
  const showBoost = boost != null && !selected && !locked;
  const ref = useRef<HTMLButtonElement>(null);
  useOddsFlash(locked ? null : price, ref);

  const original = boost?.originalPrice != null ? Number(boost.originalPrice) : null;
  const showCaret =
    showBoost &&
    price != null &&
    original != null &&
    formatOddsDisplay(original) !== formatOddsDisplay(price);

  const style: CSSProperties = {
    background: selected
      ? "var(--accent)"
      : showBoost
        ? "color-mix(in oklab, var(--positive, #16a34a) 12%, var(--surface-2))"
        : "var(--surface-2)",
    color: selected
      ? "var(--accent-fg)"
      : showBoost
        ? "var(--positive, #16a34a)"
        : "var(--fg)",
    borderColor: selected
      ? "var(--accent)"
      : showBoost
        ? "var(--positive, #16a34a)"
        : "var(--border)",
    opacity: locked ? 0.65 : 1,
    cursor: locked ? "not-allowed" : "pointer",
  };

  const priceText = locked || price == null ? "—" : formatOddsDisplay(price);

  return (
    <button
      ref={ref}
      type="button"
      className="oz-pro-cell mono tnum"
      data-wide={wide ? "true" : undefined}
      disabled={locked}
      onClick={onClick}
      style={style}
      // The column caption lives in the group header, which a screen
      // reader working through one row will never reach — so the
      // outcome's identity rides on the button itself.
      aria-label={`${label} ${priceText}`}
      title={
        showCaret && original != null
          ? `${formatOddsDisplay(original)} → ${formatOddsDisplay(price!)}`
          : undefined
      }
    >
      {showCaret ? <span className="oz-pro-boost" aria-hidden="true" /> : null}
      {line != null && !locked ? (
        <span className="oz-pro-cellline">{line}</span>
      ) : null}
      <span>{priceText}</span>
    </button>
  );
}
