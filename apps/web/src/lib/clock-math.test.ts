import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLOCK_MAX_SECONDS,
  clockSecondsAt,
  createServerClock,
  formatClock,
} from "./clock-math";

// Anchors below are the stored (normalised) form fonbet-ingester writes:
// a running clock at its zero instant, a stopped clock as its reading.

test("a running clock reads the elapsed time since its zero instant", () => {
  const clock = { seconds: 0, direction: 1, atMs: 1_000_000_000_000 };
  assert.equal(clockSecondsAt(clock, 1_000_000_000_000), 0);
  assert.equal(clockSecondsAt(clock, 1_000_000_000_000 + 2536_000), 2536);
  // Floors within the second, never rounds up — a clock that shows 42:17
  // at 42:16.9 is ahead of the broadcast.
  assert.equal(clockSecondsAt(clock, 1_000_000_000_000 + 2536_999), 2536);
});

test("a stopped clock is its reading whatever the time is", () => {
  const halfTime = { seconds: 2700, direction: 0 };
  assert.equal(clockSecondsAt(halfTime, 0), 2700);
  assert.equal(clockSecondsAt(halfTime, 9_999_999_999_999), 2700);
  // Same for a running clock that carries no instant: nothing to
  // extrapolate from, so show what we were told.
  assert.equal(clockSecondsAt({ seconds: 884, direction: 1 }, 5), 884);
});

test("a count-down clock reads the time left until its zero instant", () => {
  const clock = { seconds: 0, direction: -1, atMs: 1_000_000_300_000 };
  assert.equal(clockSecondsAt(clock, 1_000_000_000_000), 300);
  assert.equal(clockSecondsAt(clock, 1_000_000_299_000), 1);
  // Past zero it holds at zero rather than going negative.
  assert.equal(clockSecondsAt(clock, 1_000_000_400_000), 0);
});

test("a zero instant slightly in the future reads 00:00, not negative", () => {
  // The client is a second behind the feed's server: the clock has not
  // "started" from its point of view yet.
  const clock = { seconds: 0, direction: 1, atMs: 1_000_000_001_000 };
  assert.equal(clockSecondsAt(clock, 1_000_000_000_000), 0);
});

test("a dead feed cannot run the clock past the ceiling", () => {
  const clock = { seconds: 0, direction: 1, atMs: 0 };
  assert.equal(clockSecondsAt(clock, 10 * 3600 * 1000), CLOCK_MAX_SECONDS);
});

test("an unknown direction is treated as stopped, never multiplied in", () => {
  assert.equal(clockSecondsAt({ seconds: 100, direction: 7, atMs: 0 }, 60_000), 160);
  assert.equal(clockSecondsAt({ seconds: 100, direction: -3, atMs: 0 }, 60_000), 40);
  assert.equal(clockSecondsAt({ seconds: 100, direction: 0, atMs: 0 }, 60_000), 100);
});

test("no clock and a garbage reading yield null", () => {
  assert.equal(clockSecondsAt(null, 0), null);
  assert.equal(clockSecondsAt(undefined, 0), null);
  assert.equal(clockSecondsAt({ seconds: Number.NaN, direction: 1, atMs: 0 }, 0), null);
});

test("formatClock pads minutes to two digits and never folds into hours", () => {
  assert.equal(formatClock(0), "00:00");
  assert.equal(formatClock(300), "05:00");
  assert.equal(formatClock(2536), "42:16");
  assert.equal(formatClock(5520), "92:00");
  assert.equal(formatClock(3408), "56:48");
  assert.equal(formatClock(-5), "00:00");
  assert.equal(formatClock(59.9), "00:59");
});

test("server clock: the least-latency sample wins", () => {
  const sc = createServerClock();
  assert.equal(sc.offsetMs(), 0);
  // Server is 30 s ahead of this device. Three frames with 40, 120 and
  // 900 ms of latency: the 40 ms one is the closest to the truth.
  sc.observe(1_000_030_000, 1_000_000_040);
  sc.observe(1_000_031_000, 1_000_001_120);
  sc.observe(1_000_032_000, 1_000_002_900);
  assert.equal(sc.offsetMs(), 30_000 - 40);
  assert.equal(sc.now(1_000_010_000), 1_000_010_000 + 30_000 - 40);
});

test("server clock: a stale server stamp never wins", () => {
  const sc = createServerClock();
  sc.observe(1_000_030_000, 1_000_000_050);
  // A score frame whose updatedAt is the ingester's cycle start, two
  // seconds before it was published: reads as 2 s of latency.
  sc.observe(1_000_033_000, 1_000_005_050);
  assert.equal(sc.offsetMs(), 30_000 - 50);
});

test("server clock: samples age out of the window", () => {
  const sc = createServerClock(120_000);
  sc.observe(1_000_030_000, 1_000_000_000);
  // Two minutes later the device's clock was corrected by NTP: it is now
  // right, so offsets read ~0. The old +30 s sample must not linger.
  sc.observe(1_000_150_100, 1_000_150_000);
  assert.equal(sc.offsetMs(), 100);
});

test("server clock: a sample far below the best restarts the window", () => {
  const sc = createServerClock(120_000, 10_000);
  sc.observe(1_000_030_000, 1_000_000_000); // +30 s
  // Ten seconds later the laptop's clock jumped forward by an hour
  // (resume from sleep). The next frame reads an hour LOWER.
  sc.observe(1_000_040_000, 1_003_610_000);
  assert.equal(sc.offsetMs(), 1_000_040_000 - 1_003_610_000);
});

test("server clock: absurd and non-finite samples are ignored", () => {
  const sc = createServerClock();
  sc.observe(Number.NaN, 1_000);
  sc.observe(1_000, Number.NaN);
  sc.observe(1_000 + 48 * 3600 * 1000, 1_000);
  assert.equal(sc.offsetMs(), 0);
  sc.observe(2_000, 1_000);
  assert.equal(sc.offsetMs(), 1_000);
  sc.reset();
  assert.equal(sc.offsetMs(), 0);
});
