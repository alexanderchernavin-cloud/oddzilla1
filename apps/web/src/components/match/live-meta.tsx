"use client";

import { useRef } from "react";
import type { LiveScore } from "@/lib/live-score";
import { useRunningClock } from "@/lib/running-clock";
import { useValueFlash } from "@/lib/use-odds-flash";

/**
 * The live state of a fixture in one line: clock, headline score, and
 * the feed's own parenthetical detail.
 *
 * Shared by BOTH list layouts — the Pro row's meta column and the
 * Default card's header strip — so the two show the same live facts in
 * the same order. It shipped on the Pro row first and the card, with far
 * more room, had none of it: the card's scoreboard shows per-map cells
 * and hides its Σ column until a second map exists, so a first-half
 * football match showed a single "0 / 0" column and no clock at all
 * (operator, 2026-09-07).
 *
 * The clock RUNS. Until 2026-09-07 it printed `scoreboard.time`, the
 * string the feed had rendered at packet time, and so moved only when a
 * frame landed — which on a 5 s poll made every football clock a
 * stuttering count of fives, and after a WS drop a frozen one. The feed
 * carries the clock as a model (a reading, its instant, its direction),
 * the ingester stores it as an anchor that is constant while the clock
 * runs, and `useRunningClock` derives the reading every second from
 * that anchor — so between frames the clock advances on its own, and a
 * frame is needed only when the clock itself stops, restarts or is
 * corrected. Football gets one frame per half; basketball, whose clock
 * stops and starts constantly, gets one per stoppage because each one
 * moves the anchor. Untimed sports and the Oddin esports payload carry
 * no model and fall back to the static string as before.
 *
 * `comment` is what Fonbet puts beside the headline score — games in the
 * current set for tennis ("(6-5)"), the period line or added time
 * elsewhere ("(1-0)", "+2 min") — so it is rendered verbatim rather than
 * reconstructed from `periods`. It is absent on the Oddin esports
 * payload, where the headline score is the map count and there is
 * nothing to qualify it with.
 */
export function LiveMeta({ liveScore }: { liveScore: LiveScore | null }) {
  const home = liveScore?.home ?? 0;
  const away = liveScore?.away ?? 0;
  const time = useRunningClock(liveScore?.clock ?? null, liveScore?.scoreboard?.time ?? null);
  const comment = liveScore?.comment ?? null;
  const ref = useRef<HTMLSpanElement>(null);
  // One number so a change on either side flashes the pair. Direction
  // (green/red) is meaningless for a scoreline, but "this just moved"
  // is exactly the signal a dense list needs, and the alternative —
  // two independently tinted digits — reads as one side being good.
  useValueFlash(home * 1000 + away, ref);
  return (
    <>
      {time ? (
        // The server rendered the reading as of its own render time and
        // the client's differs by the page's transit — same clock, a
        // digit apart. The first tick replaces it within a second.
        <span className="mono oz-livemeta-clock" suppressHydrationWarning>
          {time}
        </span>
      ) : null}
      <span ref={ref} className="mono tnum oz-livemeta-score">
        {home}:{away}
      </span>
      {comment ? <span className="mono oz-livemeta-comment">{comment}</span> : null}
    </>
  );
}
