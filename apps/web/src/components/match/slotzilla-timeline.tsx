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

import { useMemo, useRef } from "react";
import type { SlotzillaTimelineEvent } from "@oddzilla/types/slotzilla";
import { SlotzillaEventIcon, type SlotzillaIconKind } from "./slotzilla-icons";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * How coarsely the conveyor's anchor is quantised, in seconds. Marks are
 * positioned relative to the anchor, so it moving re-lays out all of
 * them; the layer's transform covers everything between anchor steps.
 */
const ANCHOR_STEP = 30;

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
  // The conveyor moves ONE layer, not each mark.
  //
  // Transitioning `left` per mark was the obvious build and it does not
  // work: measured on production, the same DOM node's inline style went
  // 35.56% -> 30% while its rendered x never moved at all. `left` on an
  // absolutely positioned element is a layout property, and nine of them
  // transitioning at once simply does not animate.
  //
  // So marks are pinned to a FIXED anchor — their position never changes
  // once placed — and the layer holding them is translated. One
  // `transform` on one element is compositor work, which is both cheap
  // and the thing browsers reliably animate.
  //
  // The anchor is quantised so it only moves when it has to: re-anchoring
  // re-lays out every mark, and doing that every second is the churn this
  // design exists to avoid.
  const anchor = clockSeconds === null ? 0 : Math.floor(clockSeconds / ANCHOR_STEP) * ANCHOR_STEP;

  // When the anchor steps, every mark is re-laid out one step to the left
  // and the layer's transform resets by exactly the same amount — the two
  // cancel, so the strip does not actually move. But the MARKS jump
  // instantly while the TRANSFORM would animate, so for one second twice
  // a minute the whole strip would slide backwards. Suppress the
  // transition on the render that re-anchors; it comes back on the next.
  const prevAnchor = useRef(anchor);
  const reAnchored = prevAnchor.current !== anchor;
  prevAnchor.current = anchor;

  const marks = useMemo(() => {
    if (clockSeconds === null) return [];
    const span = Math.max(1, spanSeconds);
    // The layer is one span wide and holds a span's worth of events
    // BEHIND the anchor, plus whatever has landed since; the overshoot
    // scrolls in from the right as the layer slides.
    const first = anchor - span;
    return events
      .filter((e) => e.seconds >= first && e.seconds <= clockSeconds)
      .map((e) => ({
        event: e,
        // Relative to the anchor, so this is stable between re-renders.
        pct: ((e.seconds - first) / span) * 100,
      }));
  }, [events, clockSeconds, spanSeconds, anchor]);

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
        {/* The moving layer. Its width is two spans (one behind the
            anchor, one ahead) and it slides left by however far the
            clock has run past the anchor — so the right edge of the
            visible track is always "now". */}
        <div
          className="oz-slz-tl-layer"
          style={{
            transform: `translate3d(${-((to - anchor) / Math.max(1, spanSeconds)) * 100}%, 0, 0)`,
            ...(reAnchored ? { transition: "none" } : {}),
          }}
        >
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
        </div>
        {/* The right edge is now: a cursor rather than a mark, because
            it is where the clock is, not something that happened. It
            sits OUTSIDE the moving layer, since it marks the track. */}
        <span className="oz-slz-tl-now" aria-hidden />
      </div>
      <span className="oz-slz-tl-time mono" aria-hidden>
        {clockLabel(to)}
      </span>
    </div>
  );
}
