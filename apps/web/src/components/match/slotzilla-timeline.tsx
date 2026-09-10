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
import { SlotzillaEventIcon, type SlotzillaIconKind } from "./slotzilla-icons";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** mm:ss of a cumulative match-clock reading. */
function clockLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The kind drives the tint. Symbol first, because that is what the game
 * is about; otherwise a couple of shapes worth seeing in the run of play
 * (a rebound, a timeout) and a neutral mark for everything else.
 */
function kindOf(e: SlotzillaTimelineEvent): SlotzillaIconKind {
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
        // Position is a pure function of the event's own clock second
        // against the moving window. Because the window slides at a
        // constant rate, every mark's percentage decreases at a constant
        // rate too — which, with a linear CSS transition on `left`, IS
        // the conveyor: the marks drift left continuously instead of
        // jumping a poll's worth every 15 s.
        pct: ((e.seconds - from) / span) * 100,
      }));

    // No de-collision. A mark's position is its own clock second and
    // NOTHING else, which is what makes the conveyor work: every mark
    // moves at exactly the same constant rate, so a linear transition
    // carries them smoothly and no arrival disturbs a neighbour.
    //
    // Two attempts at spacing clusters apart both failed, and the reason
    // is worth keeping. Chaining from the OLD end re-anchors every mark
    // when the oldest scrolls off. Chaining from the NEW end — which
    // looked like the fix — makes every mark's position depend on the
    // newest event, so each arrival shifts the whole strip; with a 1 s
    // transition the marks then chase a target that keeps moving and
    // visibly never arrive (measured on production: inline style said
    // 4.3% while the rendered position was still at 78%).
    //
    // Overlap in a cluster is the honest picture anyway — a foul, its
    // free throws and the rebound DID happen within a second of each
    // other — and the reference design overlaps them too. Reading is
    // handled by z-order instead: scoring marks sit above texture.
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
          const kind = kindOf(event);
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
              data-kind={kind}
              data-team={event.team ?? "none"}
              data-disabled={event.disabled ? "true" : undefined}
              style={{ left: `${pct}%` }}
              title={title}
            >
              <SlotzillaEventIcon kind={kind} />
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
