"use client";

// The match timeline strip beside the reels: the last few minutes of
// play-by-play laid out on the match clock, newest at the right edge.
//
// This is the one SlotZilla surface that shows the MATCH rather than the
// reels, and that is its whole job. The reels say what three five-second
// windows produced; the strip says what the game did to produce them, so
// a bettor can see the run of play their next spin is riding rather than
// three symbols appearing from nowhere.
//
// Positions come from the scout's own cumulative match-clock second —
// the same axis the windows are ranges of — so a mark and the reel it
// fed can never disagree about when something happened.
//
// Every clocked event is drawn, not only the ones that make a symbol: a
// rebound or a timeout is part of the shape of a match. Events with no
// symbol are drawn small and unfilled so they read as texture rather
// than competing with the scoring marks.

import { useMemo } from "react";
import type { SlotzillaTimelineEvent } from "@oddzilla/types/slotzilla";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Minimum separation between two marks, as a percentage of the track.
 * An 18px mark on a ~400px track is ~4.5%, so 3% leaves adjacent marks
 * overlapping slightly — which reads as a cluster, correctly — while
 * keeping each one's centre and its hover target distinct.
 */
const MIN_GAP_PCT = 3;

/** mm:ss of a cumulative match-clock reading. */
function clockLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The glyph for one event. Scoring events carry their point value, which
 * is the same vocabulary the reels use (3 / 2 / 1), so the strip and the
 * reels are legible as one system rather than two icon sets.
 */
function glyphFor(e: SlotzillaTimelineEvent): string {
  switch (e.symbol) {
    case "P3":
      return "3";
    case "P2":
      return "2";
    case "FT":
      return "1";
    case "FOUL":
      return "F";
    case "MISS":
      return "×";
    default:
      return "";
  }
}

/**
 * The kind drives the tint. Symbol first, because that is what the game
 * is about; otherwise a couple of shapes worth seeing in the run of play
 * (a rebound, a timeout) and a neutral mark for everything else.
 */
function kindOf(e: SlotzillaTimelineEvent): string {
  if (e.symbol) return e.symbol;
  if (e.type === "rebound") return "rebound";
  if (e.type === "timeout") return "timeout";
  if (e.type === "periodstart" || e.type === "periodscore") return "period";
  return "other";
}

export interface SlotzillaTimelineProps {
  events: readonly SlotzillaTimelineEvent[];
  /** The clock reading the right edge represents. */
  clockSeconds: number | null;
  /** How much match clock the strip spans. */
  spanSeconds: number;
  homeTeam: string;
  awayTeam: string;
  /** Renders the DEMO marker above the strip. */
  demo?: boolean;
  t: Translate;
}

export function SlotzillaTimeline({
  events,
  clockSeconds,
  spanSeconds,
  homeTeam,
  awayTeam,
  demo,
  t,
}: SlotzillaTimelineProps) {
  const marks = useMemo(() => {
    if (clockSeconds === null) return [];
    const to = clockSeconds;
    const from = Math.max(0, to - spanSeconds);
    // A zero span would divide by zero on the very first seconds of a
    // match, when `to` is still inside the span.
    const span = Math.max(1, to - from);
    const placed = events
      .filter((e) => e.seconds >= from && e.seconds <= to)
      .map((e) => ({
        event: e,
        // Clamped because an event exactly at `from` lands on 0 and one
        // at `to` on 100; a mark is centred on its position, so the two
        // extremes would otherwise be half outside the strip.
        pct: Math.min(98, Math.max(2, ((e.seconds - from) / span) * 100)),
      }));

    // Basketball clusters: a foul, its free throws and the rebound can
    // share a second, and at ~1.3px per second two of those land on the
    // same pixel — measured on production, the closest pair of marks was
    // 0px apart, i.e. one completely hidden behind the other. Nudge each
    // mark to at least MIN_GAP_PCT past its predecessor so every event
    // stays individually visible and hoverable.
    //
    // This trades exact position for legibility, which is the right way
    // round here: the strip is a picture of the run of play, and the
    // windows — not the strip — are what anything is settled on. The
    // nudge is bounded (it only ever pushes right, and only within a
    // cluster) and the tooltip still reports the true clock reading.
    let prev = -Infinity;
    for (const m of placed) {
      if (m.pct < prev + MIN_GAP_PCT) m.pct = prev + MIN_GAP_PCT;
      prev = m.pct;
    }
    // A long cluster can push the last mark past the right edge; slide
    // the whole run back rather than let it escape the track.
    const last = placed[placed.length - 1];
    const overflow = last ? last.pct - 98 : 0;
    if (overflow > 0) for (const m of placed) m.pct -= overflow;
    return placed;
  }, [events, clockSeconds, spanSeconds]);

  if (clockSeconds === null) return null;

  const to = clockSeconds;
  const from = Math.max(0, to - spanSeconds);

  return (
    <div className="oz-slz-tl" aria-label={t("timelineLabel")}>
      {demo ? <span className="oz-slz-tl-demo mono">{t("demoBadge")}</span> : null}
      <span className="oz-slz-tl-time mono" aria-hidden>
        {clockLabel(from)}
      </span>
      <div className="oz-slz-tl-track">
        <span className="oz-slz-tl-rule" aria-hidden />
        {marks.map(({ event, pct }) => {
          const teamName =
            event.team === "home" ? homeTeam : event.team === "away" ? awayTeam : null;
          const glyph = glyphFor(event);
          // The title is the accessible description of the mark: what
          // happened, to whom, and when on the match clock.
          const title = [
            event.symbol ? t(`symbol.${event.symbol}`) : event.type.replace(/_/gu, " "),
            teamName,
            event.playerName,
            clockLabel(event.seconds),
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <span
              key={event.id}
              className="oz-slz-tl-mark"
              data-kind={kindOf(event)}
              data-team={event.team ?? "none"}
              data-disabled={event.disabled ? "true" : undefined}
              data-plain={glyph === "" ? "true" : undefined}
              style={{ left: `${pct}%` }}
              title={title}
            >
              <span aria-hidden>{glyph}</span>
              <span className="oz-sr-only">{title}</span>
            </span>
          );
        })}
        {/* The right edge is now: a cursor rather than a mark, because
            it is where the clock is, not something that happened. */}
        <span className="oz-slz-tl-now" aria-hidden />
      </div>
      <span className="oz-slz-tl-time mono" aria-hidden>
        {clockLabel(to)}
      </span>
    </div>
  );
}
