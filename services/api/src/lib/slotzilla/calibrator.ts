// SlotZilla calibrator — the pure half of `POST /admin/slotzilla/paytables/fit`.
//
// Takes the play-by-play corpus in `sr_live_events` (grouped per
// Sportradar match), turns every match into the sequence of 5-second
// window symbols the game would have shown, slides a 15-second round
// over every possible first window (rounds anchor at the bettor's spin,
// so every window start is a candidate), measures how often each
// paytable line lands, and scales a base paytable to the operator's
// return target with the NONE lines held fixed.
//
// Everything here is arithmetic over data the caller loaded; the
// rules themselves (which event wins a window, which line three reels
// form, the fit) are the shared module in @oddzilla/types/slotzilla so
// this cannot disagree with the storefront preview or the Go settler.

import {
  fitLinesToTarget,
  lineFrequencies,
  reelForWindow,
  slidingRounds,
  windowStartOf,
  WINDOW_SECONDS,
  type LineKey,
  type PaytableLines,
  type ReelEvent,
  type RoundReels,
  type SlotSymbol,
} from "@oddzilla/types/slotzilla";

/** One stored event, as the calibrator reads it. */
export interface CorpusEvent extends ReelEvent {
  /** Sportradar match id, as a decimal string so bigint survives JSON. */
  srMatchId: string;
}

export interface CorpusSummary {
  matches: number;
  events: number;
  rounds: number;
  /** Share of rounds landing on each line (0..1). */
  byLine: Record<LineKey, number>;
}

export interface CorpusFit {
  lines: PaytableLines;
  factor: number;
  fittedBp: number;
  corpus: { matches: number; rounds: number; byLine: Record<LineKey, number> };
}

/** Group a flat event list by Sportradar match id, preserving encounter order. */
export function groupByMatch(events: readonly CorpusEvent[]): Map<string, CorpusEvent[]> {
  const out = new Map<string, CorpusEvent[]>();
  for (const e of events) {
    const bucket = out.get(e.srMatchId);
    if (bucket) bucket.push(e);
    else out.set(e.srMatchId, [e]);
  }
  return out;
}

/**
 * The symbol of every window from the tip-off to `maxSeconds`
 * inclusive, on the fixed 5-second grid. Windows the clock passed with
 * nothing in them are NONE — a real symbol the paytable prices — so
 * the grid runs over the whole match, not just over the events.
 *
 * `maxSeconds` defaults to the latest clock reading among the events;
 * a caller that knows the match ran longer (a final `match_ended` at
 * 2400 with no symbol) passes it so the trailing empty windows count.
 */
export function windowSymbolsForMatch(
  events: readonly ReelEvent[],
  maxSeconds?: number,
): SlotSymbol[] {
  let last = -1;
  for (const e of events) if (e.seconds > last) last = e.seconds;
  const end = Math.max(last, maxSeconds ?? -1);
  if (end < 0) return [];
  const out: SlotSymbol[] = [];
  const lastWindow = windowStartOf(end);
  for (let from = 0; from <= lastWindow; from += WINDOW_SECONDS) {
    out.push(reelForWindow(events, from).symbol);
  }
  return out;
}

/**
 * Every spin-anchored round the corpus allows, match by match. Rounds
 * never cross a match boundary — a spin cannot either.
 */
export function corpusRounds(eventsByMatch: ReadonlyMap<string, readonly ReelEvent[]>): RoundReels[] {
  const rounds: RoundReels[] = [];
  for (const events of eventsByMatch.values()) {
    for (const r of slidingRounds(windowSymbolsForMatch(events))) rounds.push(r);
  }
  return rounds;
}

/** Matches, events, rounds and the measured line frequencies of a corpus. */
export function summariseCorpus(events: readonly CorpusEvent[]): CorpusSummary {
  const byMatch = groupByMatch(events);
  const rounds = corpusRounds(byMatch);
  return {
    matches: byMatch.size,
    events: events.length,
    rounds: rounds.length,
    byLine: lineFrequencies(rounds),
  };
}

/**
 * Fit `base` to `targetBp` against the corpus. The NONE lines stay at
 * the base table's values (FIXED_LINES in the shared module); every
 * other line scales by one factor. A factor of 0 means the fixed lines
 * alone exceed the target and the caller must refuse to ship the
 * result rather than seed a table whose play rows pay nothing.
 */
export function fitCorpus(
  events: readonly CorpusEvent[],
  base: PaytableLines,
  targetBp: number,
): CorpusFit {
  const summary = summariseCorpus(events);
  const fit = fitLinesToTarget(base, summary.byLine, targetBp);
  return {
    lines: fit.lines,
    factor: fit.factor,
    fittedBp: fit.fittedBp,
    corpus: { matches: summary.matches, rounds: summary.rounds, byLine: summary.byLine },
  };
}
