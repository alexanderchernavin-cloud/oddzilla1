import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEFAULT_PAYTABLE_LINES,
  evaluateLine,
  expectedReturnBp,
  exposureMicro,
  firstWindowFor,
  fitLinesToTarget,
  formatCountdown,
  formatMultiplier,
  formatWindowCountdown,
  formatWindowLabel,
  periodClock,
  lineFrequencies,
  LINE_KEYS,
  payoutMicro,
  reelForWindow,
  reelsForRound,
  slidingRounds,
  symbolForEvent,
  windowStartOf,
  type LineKey,
  type PaytableLines,
  type ReelEvent,
  type RoundReels,
  type SlotSymbol,
} from "./slotzilla.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "../../../docs/fixtures/slotzilla-rules.json"), "utf8"),
) as {
  symbols: Array<{ type: string; points: number | null; symbol: string | null }>;
  firstWindow: Array<{ clock: number; lead: number; first: number }>;
  reels: Array<{
    name: string;
    windowFrom: number;
    events: ReelEvent[];
    expect: { symbol: SlotSymbol; team: string | null; eventId: string | null };
  }>;
  lines: Array<{ reels: [SlotSymbol, SlotSymbol, SlotSymbol]; line: LineKey | null }>;
  payouts: Array<{ stakeMicro: string; multiplierX100: number; payoutMicro: string }>;
  defaultPaytable: PaytableLines;
};

describe("golden fixture — the Go port reads the same file", () => {
  test("symbols", () => {
    for (const c of fixture.symbols) {
      assert.equal(symbolForEvent({ type: c.type, points: c.points }), c.symbol, `${c.type}/${c.points}`);
    }
  });

  test("first window rounds UP to the next 5-second mark past the lead", () => {
    for (const c of fixture.firstWindow) {
      assert.equal(firstWindowFor(c.clock, c.lead), c.first, `clock ${c.clock} lead ${c.lead}`);
    }
  });

  test("reels", () => {
    for (const c of fixture.reels) {
      const r = reelForWindow(c.events, c.windowFrom);
      assert.deepEqual(
        { symbol: r.symbol, team: r.team, eventId: r.eventId },
        c.expect,
        c.name,
      );
    }
  });

  test("lines", () => {
    for (const c of fixture.lines) {
      assert.equal(evaluateLine(c.reels), c.line, c.reels.join(","));
    }
  });

  test("payouts are exact bigint arithmetic, floored", () => {
    for (const c of fixture.payouts) {
      assert.equal(payoutMicro(BigInt(c.stakeMicro), c.multiplierX100).toString(), c.payoutMicro);
    }
  });

  test("the default paytable is the fixture's", () => {
    assert.deepEqual({ ...DEFAULT_PAYTABLE_LINES }, fixture.defaultPaytable);
  });
});

describe("windows", () => {
  test("windowStartOf floors to the grid", () => {
    assert.equal(windowStartOf(0), 0);
    assert.equal(windowStartOf(4), 0);
    assert.equal(windowStartOf(5), 5);
    assert.equal(windowStartOf(2141), 2140);
  });

  test("labels are inclusive scoreboard ranges", () => {
    // Betby's 38:33–38:37 becomes 38:35–38:39 on the grid.
    assert.equal(formatWindowLabel(2315), "38:35–38:39");
    assert.equal(formatWindowLabel(0), "0:00–0:04");
  });

  test("reelsForRound covers three consecutive windows", () => {
    const events: ReelEvent[] = [
      { symbol: "P2", seconds: 101, eventId: "1", team: "home" },
      { symbol: "P3", seconds: 107, eventId: "2", team: "away" },
    ];
    const [a, b, c] = reelsForRound(events, 100);
    assert.equal(a.symbol, "P2");
    assert.equal(b.symbol, "P3");
    assert.equal(c.symbol, "NONE");
  });
});

describe("paytable maths", () => {
  test("every line key is enumerated exactly once", () => {
    assert.equal(LINE_KEYS.length, 12);
    assert.equal(new Set(LINE_KEYS).size, 12);
  });

  test("exposure is stake × top line, capped", () => {
    // Top line ×500; 1 unit staked → 500 units, capped at 300.
    assert.equal(exposureMicro(1_000_000n, DEFAULT_PAYTABLE_LINES, 300_000_000n), 300_000_000n);
    assert.equal(exposureMicro(100_000n, DEFAULT_PAYTABLE_LINES, 300_000_000n), 50_000_000n);
  });

  test("formatMultiplier prints hundredths without trailing zeros", () => {
    assert.equal(formatMultiplier(50), "0.5");
    assert.equal(formatMultiplier(100), "1");
    assert.equal(formatMultiplier(3500), "35");
    assert.equal(formatMultiplier(125), "1.25");
  });

  test("payoutMicro refuses a fractional multiplier", () => {
    assert.throws(() => payoutMicro(1n, 1.5));
  });
});

describe("calibrator", () => {
  // A toy corpus with the shape of the real one: mostly NONE, a few misses.
  const rounds: RoundReels[] = [
    ["NONE", "NONE", "NONE"],
    ["NONE", "NONE", "NONE"],
    ["NONE", "MISS", "NONE"],
    ["NONE", "NONE", "P2"],
    ["MISS", "MISS", "NONE"],
    ["P2", "NONE", "NONE"],
    ["P3", "MISS", "P2"],
    ["NONE", "NONE", "FOUL"],
  ];

  test("lineFrequencies sums to the share of rounds with a line", () => {
    const f = lineFrequencies(rounds);
    assert.equal(f["all3:NONE"], 2 / 8);
    assert.equal(f["any2:NONE"], 4 / 8);
    assert.equal(f["any2:MISS"], 1 / 8);
    assert.equal(f["any2:P3"], 0);
  });

  test("slidingRounds anchors a round at every window", () => {
    const r = slidingRounds(["NONE", "P2", "NONE", "MISS"]);
    assert.deepEqual(r, [
      ["NONE", "P2", "NONE"],
      ["P2", "NONE", "MISS"],
    ]);
    assert.deepEqual(slidingRounds(["NONE", "P2"]), []);
  });

  test("fitLinesToTarget holds the NONE rows and scales the rest to the target", () => {
    const f = lineFrequencies(rounds);
    const fit = fitLinesToTarget(DEFAULT_PAYTABLE_LINES, f, 9700);
    assert.equal(fit.lines["any2:NONE"], 50);
    assert.equal(fit.lines["all3:NONE"], 100);
    // Fixed lines return 0.5×0.5 + 1×0.25 = 0.5 here; the rest must supply 0.47.
    assert.ok(Math.abs(fit.fittedBp - 9700) <= 60, `fitted ${fit.fittedBp}`);
    assert.ok(fit.factor > 0);
    assert.equal(expectedReturnBp(fit.lines, f), fit.fittedBp);
  });

  test("a target below the fixed rows' own return floors the play rows at zero", () => {
    const f = lineFrequencies(rounds);
    const fit = fitLinesToTarget(DEFAULT_PAYTABLE_LINES, f, 1000);
    assert.equal(fit.factor, 0);
    assert.equal(fit.lines["any2:MISS"], 0);
    assert.equal(fit.lines["all3:NONE"], 100);
  });
});

// ── Countdown display ───────────────────────────────────────────────────
//
// Presentation only: window identity stays cumulative seconds, and these
// never feed settlement. What they must get right is agreeing with the
// match tracker a bettor is reading beside them.

describe("periodClock", () => {
  test("counts down inside a regulation quarter", () => {
    assert.deepEqual(periodClock(0), { period: 1, remaining: 600, overtime: false });
    // 15:39 cumulative is 5:39 into Q2, so 4:21 left.
    assert.deepEqual(periodClock(939), { period: 2, remaining: 261, overtime: false });
    assert.deepEqual(periodClock(1199), { period: 2, remaining: 1, overtime: false });
    assert.deepEqual(periodClock(1200), { period: 3, remaining: 600, overtime: false });
    assert.deepEqual(periodClock(2399), { period: 4, remaining: 1, overtime: false });
  });

  test("rolls into five-minute overtime periods", () => {
    assert.deepEqual(periodClock(2400), { period: 5, remaining: 300, overtime: true });
    assert.deepEqual(periodClock(2550), { period: 5, remaining: 150, overtime: true });
    assert.deepEqual(periodClock(2700), { period: 6, remaining: 300, overtime: true });
  });

  // The feed knows which quarter is being played; arithmetic does not,
  // if a competition runs a different period length.
  test("the feed's period wins over the derived one", () => {
    assert.equal(periodClock(939, 3).period, 3);
    assert.equal(periodClock(939, 2).period, 2);
    // Junk from the feed falls back rather than propagating.
    assert.equal(periodClock(939, 0).period, 2);
    assert.equal(periodClock(939, null).period, 2);
  });

  // A feed period that disagrees with PERIOD_SECONDS must never produce
  // a negative countdown or one longer than the period.
  test("clamps a disagreement between the feed period and the period length", () => {
    const early = periodClock(939, 1);
    assert.ok(early.remaining >= 0 && early.remaining <= 600, `got ${early.remaining}`);
    const late = periodClock(100, 4);
    assert.ok(late.remaining >= 0 && late.remaining <= 600, `got ${late.remaining}`);
  });

  test("never returns a negative reading", () => {
    assert.equal(periodClock(-50).remaining <= 600, true);
    assert.ok(periodClock(-50).remaining >= 0);
  });
});

describe("countdown formatting", () => {
  test("formats the time remaining, not the time elapsed", () => {
    assert.equal(formatCountdown(939), "4:21");
    assert.equal(formatCountdown(0), "10:00");
  });

  // Counting down means the END of a window is the SMALLER number, so
  // the range reads high-to-low; low-to-high would say it runs backwards.
  test("a window label reads high to low", () => {
    assert.equal(formatWindowCountdown(935), "4:25–4:21");
  });

  test("the cumulative label is untouched — identity is still cumulative", () => {
    assert.equal(formatWindowLabel(935), "15:35–15:39");
  });
});

// Both formats. Sportradar states the competition's own period structure
// per match (`periodlength` / `overtimelength` / `numberofperiods` on the
// match block), so the countdown reads it instead of assuming FIBA.
describe("period format", () => {
  const NBA = { periodSeconds: 720, overtimeSeconds: 300, regulationPeriods: 4 };

  test("FIBA 4x10 is the fallback when the feed says nothing", () => {
    assert.deepEqual(periodClock(939), { period: 2, remaining: 261, overtime: false });
    assert.deepEqual(periodClock(939, null, null), { period: 2, remaining: 261, overtime: false });
  });

  // The same cumulative reading is a different quarter and a different
  // countdown under 12-minute quarters — which is exactly the error a
  // hard-coded 600 made silently, since the quarter LABEL comes from the
  // feed and would have stayed right.
  test("NBA 4x12 reads its own length", () => {
    assert.deepEqual(periodClock(939, null, NBA), { period: 2, remaining: 501, overtime: false });
    assert.equal(formatCountdown(939, null, NBA), "8:21");
    assert.equal(formatCountdown(939), "4:21");
  });

  test("regulation ends where the format says it does", () => {
    // FIBA: 2400 is overtime. NBA: 2400 is still the fourth quarter.
    assert.equal(periodClock(2400).overtime, true);
    assert.equal(periodClock(2400, null, NBA).overtime, false);
    assert.deepEqual(periodClock(2880, null, NBA), { period: 5, remaining: 300, overtime: true });
  });

  test("a malformed format falls back rather than dividing by it", () => {
    const bad = { periodSeconds: 0, overtimeSeconds: -1, regulationPeriods: 0 };
    assert.deepEqual(periodClock(939, null, bad), { period: 2, remaining: 261, overtime: false });
  });

  test("window labels follow the format too", () => {
    assert.equal(formatWindowCountdown(935, null, NBA), "8:25–8:21");
    assert.equal(formatWindowCountdown(935), "4:25–4:21");
  });
});
