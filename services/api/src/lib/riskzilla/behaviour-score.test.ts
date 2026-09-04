// Unit tests for the pure behaviour-scoring helpers.
//
// Run with: tsx --test src/lib/riskzilla/behaviour-score.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  combineUserScore,
  extractFeatures,
  resolveAlert,
  scoreSession,
  type ClickSample,
  type MouseSample,
} from "./behaviour-score.js";

// Deterministic LCG so the "human" fixture is reproducible.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

// Puppeteer-style move: linear interpolation at a constant rate.
function botSegment(t0: number, n = 80): MouseSample[] {
  const out: MouseSample[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ t: t0 + i * 120, x: 100 + i * 10, y: 100 + i * 6.25 });
  }
  return out;
}

// Hand on a mouse: wandering heading, varying step length, jittered dt.
function humanSegment(t0: number, n = 200, seed = 7): MouseSample[] {
  const rnd = lcg(seed);
  const out: MouseSample[] = [];
  let x = 400;
  let y = 300;
  let heading = 0;
  let t = t0;
  for (let i = 0; i < n; i += 1) {
    heading += (rnd() - 0.5) * 2.4;
    const step = 4 + rnd() * 56;
    x += Math.cos(heading) * step;
    y += Math.sin(heading) * step;
    t += 120 + Math.round((rnd() - 0.5) * 40);
    out.push({ t, x: Math.round(x), y: Math.round(y) });
  }
  return out;
}

function metronomeClicks(t0: number, n: number, gapMs: number): ClickSample[] {
  return Array.from({ length: n }, (_, i) => ({ t: t0 + i * gapMs, x: 50, y: 50 }));
}

function irregularClicks(t0: number, n: number, seed = 11): ClickSample[] {
  const rnd = lcg(seed);
  const out: ClickSample[] = [];
  let t = t0;
  for (let i = 0; i < n; i += 1) {
    t += 700 + Math.round(rnd() * 3300);
    out.push({ t, x: 50, y: 50 });
  }
  return out;
}

describe("extractFeatures", () => {
  it("measures a linear interpolated move as perfectly straight and constant-speed", () => {
    const f = extractFeatures({ segments: [botSegment(0)], clicks: [], viewportW: 1440 });
    assert.equal(f.points, 80);
    assert.ok(f.straightness != null && f.straightness > 0.999, `straightness ${f.straightness}`);
    assert.ok(f.speedCv != null && f.speedCv < 0.01, `speedCv ${f.speedCv}`);
    assert.ok(f.headingEntropy != null && f.headingEntropy < 0.05, `entropy ${f.headingEntropy}`);
    assert.equal(f.touchLike, false);
  });

  it("measures a wandering hand as curved, variable-speed, high-entropy", () => {
    const f = extractFeatures({ segments: [humanSegment(0)], clicks: [], viewportW: 1440 });
    assert.ok(f.straightness != null && f.straightness < 0.9, `straightness ${f.straightness}`);
    assert.ok(f.speedCv != null && f.speedCv > 0.3, `speedCv ${f.speedCv}`);
    // Heading changes of up to +-1.2 rad concentrate in the middle bins,
    // so a hand lands around 0.65-0.75 here; the scorer treats anything
    // above 0.65 as fully human (suspicion 0).
    assert.ok(f.headingEntropy != null && f.headingEntropy > 0.6, `entropy ${f.headingEntropy}`);
  });

  it("withholds trajectory features below the minimum sample count", () => {
    const f = extractFeatures({ segments: [botSegment(0, 10)], clicks: [], viewportW: 1440 });
    assert.equal(f.points, 10);
    assert.equal(f.straightness, null);
    assert.equal(f.speedCv, null);
    assert.equal(f.headingEntropy, null);
  });

  it("counts clicks with no pointer sample in the preceding window as unapproached", () => {
    // Movement runs 0..9480 ms; clicks start 20 s later with nothing moving.
    const f = extractFeatures({
      segments: [botSegment(0)],
      clicks: metronomeClicks(20_000, 8, 1000),
      viewportW: 1440,
    });
    assert.equal(f.clicksWithoutApproach, 1);
    // Clicks landing inside the movement window are approached.
    const g = extractFeatures({
      segments: [botSegment(0)],
      clicks: metronomeClicks(1_000, 8, 1000),
      viewportW: 1440,
    });
    assert.equal(g.clicksWithoutApproach, 0);
  });

  it("flags a narrow viewport with no pointer data as touch-like and skips the approach feature", () => {
    const f = extractFeatures({
      segments: [],
      clicks: irregularClicks(0, 12),
      viewportW: 390,
    });
    assert.equal(f.touchLike, true);
    assert.equal(f.clicksWithoutApproach, null);
  });

  it("ignores idle gaps when measuring click rhythm", () => {
    const clicks = [
      ...metronomeClicks(0, 5, 1000),
      // 10-minute break, then five more
      ...metronomeClicks(600_000, 5, 1000),
    ];
    const f = extractFeatures({ segments: [], clicks, viewportW: 1440 });
    // 8 usable intervals of exactly 1000 ms -> cv 0
    assert.equal(f.clickIntervalCv, 0);
    assert.equal(f.medianClickIntervalMs, 1000);
  });
});

describe("scoreSession", () => {
  it("scores an automation-shaped session near 1", () => {
    const { result } = scoreSession({
      segments: [botSegment(0)],
      clicks: metronomeClicks(20_000, 8, 1000),
      viewportW: 1440,
    });
    assert.ok(result.score != null && result.score >= 0.9, `score ${result.score}`);
    assert.ok(result.reasons.includes("straight_line_movement"));
    assert.ok(result.reasons.includes("constant_speed_movement"));
    assert.ok(result.reasons.includes("clicks_without_pointer_approach"));
    assert.ok(result.reasons.includes("metronomic_click_timing"));
  });

  it("scores a hand-shaped session low", () => {
    const seg = humanSegment(0);
    const last = seg[seg.length - 1]!.t;
    // Clicks spread across the movement window so each has an approach.
    const clicks = irregularClicks(0, 10).filter((c) => c.t < last);
    const { result } = scoreSession({ segments: [seg], clicks, viewportW: 1440 });
    assert.ok(result.score != null && result.score <= 0.35, `score ${result.score}`);
    assert.equal(result.reasons.length, 0);
  });

  it("returns null with fewer than two usable components", () => {
    // Tiny trajectory, two clicks: nothing qualifies.
    const a = scoreSession({ segments: [botSegment(0, 10)], clicks: metronomeClicks(0, 2, 500), viewportW: 1440 });
    assert.equal(a.result.score, null);
    // Touch device: only click rhythm is available -> not enough alone.
    const b = scoreSession({ segments: [], clicks: irregularClicks(0, 12), viewportW: 390 });
    assert.equal(b.result.score, null);
  });

  it("still scores a desktop session that clicks without ever moving the pointer", () => {
    const { result } = scoreSession({
      segments: [],
      clicks: metronomeClicks(0, 8, 1000),
      viewportW: 1440,
    });
    assert.ok(result.score != null && result.score >= 0.9, `score ${result.score}`);
  });
});

describe("combineUserScore", () => {
  it("weights sessions by sample count", () => {
    const s = combineUserScore(
      [
        { score: 1, points: 2000 },
        { score: 0, points: 0 },
      ],
      null,
    );
    // (1*2001 + 0*1) / 2002
    assert.ok(s != null && s > 0.99, `score ${s}`);
  });

  it("blends the confirm-time signal only with enough tickets", () => {
    const base = combineUserScore([{ score: 0.5, points: 100 }], { n: 3, fastShare: 1 });
    assert.equal(base, 0.5);
    const blended = combineUserScore([{ score: 0.5, points: 100 }], { n: 20, fastShare: 1 });
    // 0.5 * 0.8 + 1 * 0.2
    assert.equal(blended, 0.6);
  });

  it("caps a confirm-time-only score well below any sane alert threshold", () => {
    const s = combineUserScore([], { n: 50, fastShare: 1 });
    assert.equal(s, 0.2);
  });

  it("returns null with nothing to go on", () => {
    assert.equal(combineUserScore([], null), null);
    assert.equal(combineUserScore([], { n: 2, fastShare: 1 }), null);
  });
});

describe("resolveAlert", () => {
  it("requires the minimum number of scored sessions", () => {
    assert.equal(
      resolveAlert({ score: 0.95, sessionsScored: 1, threshold: 0.7, minSessions: 2, wasAlert: false }),
      false,
    );
    assert.equal(
      resolveAlert({ score: 0.95, sessionsScored: 2, threshold: 0.7, minSessions: 2, wasAlert: false }),
      true,
    );
  });

  it("holds an existing alert through the hysteresis band", () => {
    assert.equal(
      resolveAlert({ score: 0.65, sessionsScored: 5, threshold: 0.7, minSessions: 2, wasAlert: true }),
      true,
    );
    assert.equal(
      resolveAlert({ score: 0.65, sessionsScored: 5, threshold: 0.7, minSessions: 2, wasAlert: false }),
      false,
    );
    assert.equal(
      resolveAlert({ score: 0.55, sessionsScored: 5, threshold: 0.7, minSessions: 2, wasAlert: true }),
      false,
    );
  });

  it("never alerts on an unscored bettor", () => {
    assert.equal(
      resolveAlert({ score: null, sessionsScored: 9, threshold: 0.7, minSessions: 2, wasAlert: true }),
      false,
    );
  });
});
