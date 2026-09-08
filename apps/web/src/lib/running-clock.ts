"use client";

import { useEffect, useState } from "react";
import { clockSecondsAt, createServerClock, formatClock } from "./clock-math";
import type { LiveScoreClock } from "./live-score";

/**
 * The one server-clock estimate for this tab. Fed by every WS frame the
 * shared socket dispatches (use-live-odds.ts) and read by every running
 * clock on the page, so a device whose clock is a minute off shows the
 * match at the same minute the broadcast does.
 */
export const serverClock = createServerClock();

export function observeServerTime(serverMs: number): void {
  serverClock.observe(serverMs);
}

// One ticker for the whole page. A hundred live rows must not mean a
// hundred intervals: every subscriber is woken by the same timeout,
// aligned to the next whole second so the column changes in one paint
// rather than shimmering row by row. React batches the resulting
// setState calls into one render. Reads the wall clock on every tick
// instead of counting, so a throttled background tab catches up the
// instant it is visible again and never accumulates drift.
type Tick = (nowMs: number) => void;
const subscribers = new Set<Tick>();
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule() {
  const delay = 1000 - (Date.now() % 1000);
  timer = setTimeout(() => {
    timer = null;
    if (subscribers.size === 0) return;
    const now = serverClock.now();
    for (const tick of subscribers) tick(now);
    schedule();
  }, delay);
}

function subscribeTicker(tick: Tick): () => void {
  subscribers.add(tick);
  if (timer === null) schedule();
  return () => {
    subscribers.delete(tick);
    if (subscribers.size === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/**
 * The match clock as text, running. Returns `fallback` when the payload
 * carries no clock model — the Oddin esports payload and the untimed
 * sports, where `scoreboard.time` is the feed's own static string.
 *
 * Only a RUNNING clock subscribes to the ticker: a stopped one (half
 * time, an intermission) is a constant and re-renders only when the
 * next frame changes it. Between frames the reading is derived from the
 * anchor, so it moves every second whether or not the feed says
 * anything — a football half needs one frame, a basketball game gets a
 * frame at every stoppage and restart because those change the anchor.
 *
 * On the server this renders the reading as of render time, which is
 * the right thing for the first paint; the client's first render during
 * hydration is a few hundred milliseconds later and may differ in the
 * last digit, so the caller marks the span `suppressHydrationWarning`
 * and the effect below re-renders with the live value immediately.
 */
export function useRunningClock(
  clock: LiveScoreClock | null | undefined,
  fallback: string | null,
): string | null {
  const running = Boolean(clock && clock.direction !== 0 && clock.atMs != null);
  const [nowMs, setNowMs] = useState<number>(() => serverClock.now());
  useEffect(() => {
    if (!running) return;
    setNowMs(serverClock.now());
    return subscribeTicker(setNowMs);
  }, [running]);
  if (!clock) return fallback;
  const seconds = clockSecondsAt(clock, nowMs);
  return seconds == null ? fallback : formatClock(seconds);
}
