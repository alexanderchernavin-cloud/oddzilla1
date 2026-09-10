// Unit tests for the pure half of the SlotZilla api service: block
// reasons, the clock estimate, the fallback window build, the spin
// view and the cursor.
//
// Run with: tsx --test src/lib/slotzilla/service.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { firstWindowFor } from "@oddzilla/types/slotzilla";
import {
  clockIsFresh,
  decodeSpinCursor,
  encodeSpinCursor,
  estimatedClockSeconds,
  parseStateFrame,
  paytableLinesOf,
  returnBp,
  spinBlockFor,
  spinToView,
  windowsFromEvents,
  type BlockInput,
} from "./service.js";

const NOW = 1_800_000_000_000;

function block(over: Partial<BlockInput> = {}): BlockInput {
  return {
    enabled: true,
    hasUser: true,
    gameStatus: "live",
    clockRunning: true,
    clockReadAtMs: NOW - 2_000,
    nowMs: NOW,
    feedDarkVoidSeconds: 180,
    hasOpenSpin: false,
    ...over,
  };
}

describe("spinBlockFor", () => {
  it("allows a live, running, fresh game for a signed-in bettor with no open spin", () => {
    assert.equal(spinBlockFor(block()), null);
  });

  it("applies the reasons in the contract's order", () => {
    assert.equal(spinBlockFor(block({ enabled: false, hasUser: false })), "disabled");
    assert.equal(spinBlockFor(block({ hasUser: false, gameStatus: "paused" })), "sign_in");
    assert.equal(spinBlockFor(block({ gameStatus: "paused", clockRunning: false })), "game_paused");
    assert.equal(spinBlockFor(block({ gameStatus: "scheduled" })), "game_not_live");
    assert.equal(spinBlockFor(block({ gameStatus: "ended" })), "game_not_live");
    assert.equal(spinBlockFor(block({ clockRunning: false, hasOpenSpin: true })), "clock_stopped");
    assert.equal(spinBlockFor(block({ hasOpenSpin: true })), "open_spin");
  });

  it("treats a stale clock reading as a stopped clock", () => {
    assert.equal(spinBlockFor(block({ clockReadAtMs: NOW - 181_000 })), "clock_stopped");
    assert.equal(spinBlockFor(block({ clockReadAtMs: null })), "clock_stopped");
    assert.equal(spinBlockFor(block({ clockReadAtMs: NOW - 179_000 })), null);
  });
});

describe("clock", () => {
  it("advances a running clock by whole seconds since the reading", () => {
    assert.equal(estimatedClockSeconds(2072, true, NOW - 4_900, NOW), 2076);
    assert.equal(estimatedClockSeconds(2072, true, NOW + 5_000, NOW), 2072);
  });
  it("holds a stopped clock and passes null through", () => {
    assert.equal(estimatedClockSeconds(2072, false, NOW - 60_000, NOW), 2072);
    assert.equal(estimatedClockSeconds(2072, true, null, NOW), 2072);
    assert.equal(estimatedClockSeconds(null, true, NOW, NOW), null);
  });
  it("puts the first window on the 5-second grid at least lead seconds ahead", () => {
    const clock = estimatedClockSeconds(2313, true, NOW - 0, NOW)!;
    // Betby's 38:33 becomes our 38:35 with a 10-second lead: 2313 + 10 = 2323 -> 2325.
    assert.equal(firstWindowFor(clock, 10), 2325);
  });
  it("freshness is measured against the feed-dark threshold", () => {
    assert.equal(clockIsFresh(NOW - 1_000, NOW, 180), true);
    assert.equal(clockIsFresh(NOW - 180_000, NOW, 180), false);
    assert.equal(clockIsFresh(null, NOW, 180), false);
  });
});

describe("windowsFromEvents", () => {
  it("builds the grid over the lookback and marks windows final past clock + past seconds", () => {
    const windows = windowsFromEvents(
      [
        { symbol: "P2", seconds: 2302, team: "home", eventId: "1" },
        { symbol: "FOUL", seconds: 2303, team: "away", eventId: "2" },
        { symbol: "P3", seconds: 2312, team: "away", eventId: "3" },
      ],
      2320,
      5,
      20,
    );
    assert.deepEqual(
      windows.map((w) => [w.from, w.symbol, w.final]),
      [
        [2300, "P2", true],
        [2305, "NONE", true],
        [2310, "P3", true],
        [2315, "NONE", false],
        [2320, "NONE", false],
      ],
    );
    assert.equal(windows[0]?.team, "home");
    assert.equal(windows[0]?.eventId, "1");
  });

  it("never starts before the tip-off", () => {
    const windows = windowsFromEvents([], 7, 5, 90);
    assert.deepEqual(
      windows.map((w) => w.from),
      [0, 5],
    );
  });
});

describe("parseStateFrame", () => {
  it("accepts a frame the service wrote and drops malformed windows", () => {
    const frame = parseStateFrame(
      JSON.stringify({
        type: "slotzilla_state",
        matchId: "42",
        status: "live",
        clock: { seconds: 100, running: true, atMs: NOW, period: 1 },
        windows: [
          { from: 95, symbol: "P2", team: "home", eventId: "1", final: true },
          { from: "x", symbol: "P2" },
          { from: 100, symbol: "NOPE" },
        ],
        ts: NOW,
      }),
    );
    assert.ok(frame);
    assert.equal(frame.matchId, "42");
    assert.equal(frame.windows.length, 1);
  });
  it("rejects anything else", () => {
    assert.equal(parseStateFrame(null), null);
    assert.equal(parseStateFrame("not json"), null);
    assert.equal(parseStateFrame(JSON.stringify({ type: "odds", matchId: "1" })), null);
  });
});

describe("spinToView", () => {
  const base = {
    id: "3b0d7f1e-0000-4000-8000-000000000001",
    matchId: 707005n,
    currency: "OZ  ",
    stakeMicro: 5_000_000n,
    windowFrom: 2325,
    reels: null,
    reelTeams: null,
    lineKey: null,
    multiplierX100: null,
    payoutMicro: 0n,
    status: "open" as const,
    voidReason: null,
    placedAt: new Date("2026-09-09T20:00:00.000Z"),
    settledAt: null,
  };

  it("serialises an open spin with null reels and bigints as strings", () => {
    const v = spinToView(base);
    assert.equal(v.currency, "OZ");
    assert.equal(v.stakeMicro, "5000000");
    assert.equal(v.matchId, "707005");
    assert.deepEqual(v.windows, [2325, 2330, 2335]);
    assert.deepEqual(v.reels, [null, null, null]);
    assert.deepEqual(v.reelTeams, [null, null, null]);
    assert.equal(v.payoutMicro, "0");
    assert.equal(v.settledAt, null);
    assert.equal(v.placedAt, "2026-09-09T20:00:00.000Z");
  });

  it("serialises a settled spin's reels, line and payout", () => {
    const v = spinToView({
      ...base,
      reels: ["P2", "P2", "MISS"],
      // A window with no event has no team; the column is text[] so the
      // service stores an empty string there and the view reads it as null.
      reelTeams: ["home", "away", ""],
      lineKey: "any2:P2",
      multiplierX100: 1800,
      payoutMicro: 90_000_000n,
      status: "won",
      settledAt: new Date("2026-09-09T20:00:30.000Z"),
    });
    assert.deepEqual(v.reels, ["P2", "P2", "MISS"]);
    assert.deepEqual(v.reelTeams, ["home", "away", null]);
    assert.equal(v.lineKey, "any2:P2");
    assert.equal(v.multiplierX100, 1800);
    assert.equal(v.payoutMicro, "90000000");
    assert.equal(v.status, "won");
  });
});

describe("paytableLinesOf", () => {
  it("keeps only known line keys with non-negative integer multipliers", () => {
    assert.deepEqual(
      paytableLinesOf({ "any2:P2": 1800, "all3:P2": 2.5, bogus: 1, "any2:FT": -1, "all3:NONE": 100 }),
      { "any2:P2": 1800, "all3:NONE": 100 },
    );
    assert.deepEqual(paytableLinesOf(null), {});
  });
});

describe("cursor", () => {
  it("round-trips and rejects garbage", () => {
    const at = new Date("2026-09-09T20:00:00.123Z");
    const c = encodeSpinCursor(at, "abc");
    assert.deepEqual(decodeSpinCursor(c), { placedAt: at, id: "abc" });
    assert.equal(decodeSpinCursor(undefined), null);
    assert.equal(decodeSpinCursor("!!!"), null);
    assert.equal(decodeSpinCursor(Buffer.from("nodelimiter").toString("base64url")), null);
  });
});

describe("returnBp", () => {
  it("is payout over stake in basis points, null with no stake", () => {
    assert.equal(returnBp(1_000_000n, 970_000n), 9700);
    assert.equal(returnBp(0n, 0n), null);
  });
});
