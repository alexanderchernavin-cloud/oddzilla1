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
import { memo, useMemo, useRef } from "react";
import type { CSSProperties, MouseEvent } from "react";
import { SportGlyph } from "@/components/ui/sport-glyph";
import { LiveDot } from "@/components/ui/primitives";
import { TierMark, isFeaturedTier } from "@/components/ui/tier-mark";
import { I } from "@/components/ui/icons";
import { useBetSlip } from "@/lib/bet-slip";
import { servingSide, type LiveScore } from "@/lib/live-score";
import { useOddsFlash, useValueFlash } from "@/lib/use-odds-flash";
import { useTranslations } from "@/lib/i18n";
import {
  matchWinnerSelection,
  type MatchWinnerSide,
} from "@/lib/match-winner-selection";
import { ServeMark } from "./serve-mark";
import { LocalDateTime } from "./local-datetime";
import type { ListLadderMarket, ListMatch, ListMatchOutcome } from "./match-row";
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

// ── Column model ────────────────────────────────────────────────────

type GroupKind = "result" | "handicap" | "total";

interface ResultColumn {
  label: string;
  side: MatchWinnerSide;
}

/**
 * Which result columns a tournament group shows.
 *
 * Driven by the group's own rows so a tennis group never carries a dead
 * "X" column and a football group always does, even for the one fixture
 * in it whose draw is momentarily suspended — a column that appeared
 * and disappeared per row would defeat the alignment this layout exists
 * for. Read off the SSR market STRUCTURE rather than off prices, so a
 * live tick can never add or remove a column mid-session.
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
 * Which market groups a tournament group renders at all.
 *
 * A group whose every row lacks a handicap (or a total) drops that
 * column entirely rather than printing a column of em dashes — an
 * esports series with no map handicap, a tournament between rounds.
 * The groups that DO appear are then hidden or shown by container width
 * in CSS: this decides "is there anything here", the stylesheet decides
 * "is there room for it".
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

export function MatchTable({ matches }: { matches: TableMatch[] }) {
  const groups = useMemo(() => groupByTournament(matches), [matches]);
  return (
    <div className="oz-pro-table">
      {groups.map((g) => (
        <ProGroup key={g.key} group={g} />
      ))}
    </div>
  );
}

interface LadderLabels {
  handicap: string;
  total: string;
  over: string;
  under: string;
}

/** Caption for one cell position, with the width class it must match. */
interface Caption {
  text: string;
  variant?: "wide" | "line";
}

function ProGroup({ group }: { group: TournamentGroup }) {
  const tMatch = useTranslations("match");
  const tCommon = useTranslations("common");
  const tw = useTranslations("matchWidgets");
  const resultColumns = useMemo(
    () => resultColumnsFor(group.matches),
    [group.matches],
  );
  const marketGroups = useMemo(
    () => marketGroupsFor(group.matches),
    [group.matches],
  );
  const featured = isFeaturedTier(group.riskTier);

  const labels: LadderLabels = useMemo(
    () => ({
      handicap: tw("listMarkets.handicap"),
      total: tw("listMarkets.total"),
      over: tw("listMarkets.over"),
      under: tw("listMarkets.under"),
    }),
    [tw],
  );

  const captionsFor = (kind: GroupKind): Caption[] => {
    if (kind === "result") return resultColumns.map((c) => ({ text: c.label }));
    if (kind === "handicap") {
      return [
        { text: tw("listMarkets.handicapHome"), variant: "wide" },
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
}: {
  match: TableMatch;
  resultColumns: ResultColumn[];
  marketGroups: GroupKind[];
  drawLabel: string;
  labels: LadderLabels;
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
    return ([false, true] as const).map((isAway) => {
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
  }

  function renderTotal() {
    return [
      <span key="line" className="mono tnum oz-pro-linecell">
        {total ? total.line : "—"}
      </span>,
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
            <span className="oz-pro-team">
              {match.homeTeam}
              {serving === "home" ? <ServeMark /> : null}
            </span>
            <span className="oz-pro-vs" aria-hidden="true">
              —
            </span>
            <span className="oz-pro-team">
              {match.awayTeam}
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
 * The live half of a row: clock, score, and the feed's own parenthetical
 * detail.
 *
 * `comment` is what Fonbet puts beside the headline score — games in the
 * current set for tennis ("(6-5)"), the per-period line elsewhere — so
 * it is rendered verbatim rather than reconstructed from `periods`. It
 * is absent on the Oddin esports payload, where the headline score is
 * the map count and there is nothing to qualify it with.
 */
function LiveMeta({ liveScore }: { liveScore: LiveScore | null }) {
  const home = liveScore?.home ?? 0;
  const away = liveScore?.away ?? 0;
  const time = liveScore?.scoreboard?.time ?? null;
  const comment = liveScore?.comment ?? null;
  const ref = useRef<HTMLSpanElement>(null);
  // One number so a change on either side flashes the pair. Direction
  // (green/red) is meaningless for a scoreline, but "this just moved"
  // is exactly the signal a dense list needs, and the alternative —
  // two independently tinted digits — reads as one side being good.
  useValueFlash(home * 1000 + away, ref);
  return (
    <>
      {time ? <span className="mono oz-pro-clock">{time}</span> : null}
      <span ref={ref} className="mono tnum oz-pro-score">
        {home}:{away}
      </span>
      {comment ? <span className="mono oz-pro-comment">{comment}</span> : null}
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
