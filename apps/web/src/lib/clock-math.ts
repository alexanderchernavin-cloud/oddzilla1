// Pure arithmetic behind the running match clock — no React, no DOM, so
// it is unit-tested directly (clock-math.test.ts). The hook that ticks
// it lives in running-clock.ts.
//
// A live row does not receive the clock as a reading; it receives an
// ANCHOR (see LiveScoreClock) and derives the reading at whatever
// instant it is asked for. That is what lets the storefront run a
// football half from one frame: the anchor is constant while the clock
// runs, and the display is a function of the current time.

import type { LiveScoreClock } from "./live-score";

/**
 * Ceiling on a derived reading. A clock is only ever extrapolated from an
 * anchor — there is no per-sport length to check against, and a match
 * stuck `live` on a dead feed WILL keep counting, which is honest (the
 * row is stale) but should not reach "9999:59". Six hours covers every
 * sport we time with room for the longest cricket-adjacent oddity.
 */
export const CLOCK_MAX_SECONDS = 6 * 3600;

function clampSeconds(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > CLOCK_MAX_SECONDS) return CLOCK_MAX_SECONDS;
  return v;
}

/**
 * The clock's reading, in whole seconds, at instant `nowMs` (server
 * time — see `createServerClock`). Null when there is no clock at all.
 *
 * A stopped clock is its stored reading regardless of `nowMs`; so is a
 * running clock that arrived without an instant, since there is nothing
 * to extrapolate from. The direction is squashed to -1 / 0 / 1 rather
 * than multiplied in raw: the ingester already refuses anything else,
 * and a payload written by hand must not run the clock at 7x.
 */
export function clockSecondsAt(
  clock: LiveScoreClock | null | undefined,
  nowMs: number,
): number | null {
  if (!clock) return null;
  const base = Number(clock.seconds);
  if (!Number.isFinite(base)) return null;
  const dir = clock.direction > 0 ? 1 : clock.direction < 0 ? -1 : 0;
  if (dir === 0 || clock.atMs == null || !Number.isFinite(clock.atMs)) {
    return Math.floor(clampSeconds(base));
  }
  const elapsed = (nowMs - clock.atMs) / 1000;
  if (!Number.isFinite(elapsed)) return Math.floor(clampSeconds(base));
  return Math.floor(clampSeconds(base + dir * elapsed));
}

/**
 * "MM:SS" with the minutes padded to at least two digits and never
 * folded into hours — football reads "92:14", not "1:32:14", and the
 * mono column in the list stays the same width for "05:00" (an MMA
 * round) and "56:48" (a hockey game). Fonbet itself prints "5:00"; the
 * padding is ours, for the column.
 */
export function formatClock(seconds: number): string {
  const s = Math.floor(clampSeconds(seconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm < 10 ? "0" : ""}${mm}:${ss < 10 ? "0" : ""}${ss}`;
}

/**
 * Estimates the offset between the server's clock and this device's, so
 * the anchor (stated in server time) can be compared against a "now"
 * in the same frame of reference. A phone that is a minute fast would
 * otherwise show every match a minute ahead of the broadcast.
 *
 * Every WS frame carries a server timestamp (`ts` on odds and status
 * ticks, `updatedAt` on score frames), and each one is an observation
 * `offset_i = serverMs − clientReceiveMs = trueOffset − latency_i`. The
 * latency is never negative, so the observation with the LEAST latency
 * is the largest, and the best estimate is the max over a recent
 * window. A stale server stamp (a score frame whose `updatedAt` is the
 * ingester's cycle start, a second or two old) only ever produces a
 * smaller value and so never wins.
 *
 * Two guards keep it honest over a long-lived tab: samples older than
 * `windowMs` are dropped (a laptop that slept and woke with a corrected
 * clock must not keep the pre-sleep offset), and a new sample more than
 * `jumpMs` BELOW the current best is read as a discontinuity — either
 * clock stepped — and restarts the window from that sample.
 *
 * With no observations (SSR, the first second of a page) the offset is
 * 0 and the device's own clock is used, which is right for the vast
 * majority of NTP-synced devices anyway.
 */
export interface ServerClock {
  observe(serverMs: number, clientMs?: number): void;
  offsetMs(): number;
  now(clientMs?: number): number;
  reset(): void;
}

const SANE_OFFSET_MS = 24 * 3600 * 1000;

export function createServerClock(windowMs = 120_000, jumpMs = 10_000): ServerClock {
  let samples: Array<{ clientMs: number; offset: number }> = [];
  let best = 0;
  let has = false;

  function recompute(clientMs: number) {
    samples = samples.filter((s) => clientMs - s.clientMs <= windowMs && s.clientMs <= clientMs);
    has = samples.length > 0;
    best = has ? Math.max(...samples.map((s) => s.offset)) : 0;
  }

  return {
    observe(serverMs, clientMs = Date.now()) {
      if (!Number.isFinite(serverMs) || !Number.isFinite(clientMs)) return;
      const offset = serverMs - clientMs;
      if (Math.abs(offset) > SANE_OFFSET_MS) return;
      if (has && offset < best - jumpMs) samples = [];
      samples.push({ clientMs, offset });
      recompute(clientMs);
    },
    offsetMs() {
      return has ? best : 0;
    },
    now(clientMs = Date.now()) {
      return clientMs + (has ? best : 0);
    },
    reset() {
      samples = [];
      best = 0;
      has = false;
    },
  };
}
