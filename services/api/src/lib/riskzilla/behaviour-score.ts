// Behavioural automation scoring — pure functions over the signals the
// first-party analytics tracker already persists (sampled mouse trails
// at ~8 Hz while moving, every click with viewport coordinates). No DB,
// no clock: `behaviour-sweeper.ts` loads a session, calls these, stores
// the result. Everything is unit-tested in behaviour-score.test.ts.
//
// The score is a likelihood in [0, 1] that a session was driven by
// automation rather than a hand on a pointer. It is deliberately
// conservative:
//
//   * every component needs a minimum amount of data before it counts;
//   * a session with fewer than two usable components is NOT scored
//     (null) rather than guessed — a touch device produces no pointer
//     samples at all, and flagging every phone would make the alert
//     useless;
//   * the operator reads it as a signal next to velocity, confirm-time
//     and RiskZilla PnL, never as an automatic block.
//
// Components (each mapped to a suspicion in [0, 1] by a linear ramp):
//
//   straightness           mean chord/path ratio over 6-point windows.
//                          Interpolated bot moves are geometric lines
//                          (ratio ~1.0); a hand overshoots and corrects.
//   speedCv                coefficient of variation of point speeds.
//                          Hands accelerate and decelerate every move;
//                          automation moves at a constant rate.
//   headingEntropy         normalised entropy of heading changes between
//                          consecutive displacements. Straight lines
//                          have almost none.
//   clicksWithoutApproach  share of clicks with no mouse sample in the
//                          preceding 1.5 s. `page.click()` teleports the
//                          pointer; a hand travels to the button first.
//   clickIntervalCv        regularity of inter-click gaps. Metronomic
//                          clicking is a script; people pause to read.

export interface MouseSample {
  // Absolute epoch ms.
  t: number;
  x: number;
  y: number;
}

export interface ClickSample {
  t: number;
  x: number | null;
  y: number | null;
}

export interface SessionSignals {
  // One array per persisted mouse batch (a contiguous movement segment).
  segments: MouseSample[][];
  clicks: ClickSample[];
  viewportW: number | null;
}

export interface BehaviourFeatures {
  points: number;
  clicks: number;
  straightness: number | null;
  speedCv: number | null;
  headingEntropy: number | null;
  clicksWithoutApproach: number | null;
  clickIntervalCv: number | null;
  medianClickIntervalMs: number | null;
  // No pointer samples at all on a narrow viewport — almost certainly a
  // phone or tablet, where the absence of mouse data means nothing.
  touchLike: boolean;
}

export type ComponentKey =
  | "straightness"
  | "speedCv"
  | "headingEntropy"
  | "clicksWithoutApproach"
  | "clickIntervalCv";

export interface BehaviourScore {
  // null = insufficient data to say anything.
  score: number | null;
  components: Partial<Record<ComponentKey, number>>;
  reasons: string[];
}

export const MIN_TRAJECTORY_POINTS = 60;
export const MIN_CLICKS_FOR_APPROACH = 4;
export const MIN_CLICK_INTERVALS = 6;
export const APPROACH_WINDOW_MS = 1500;
export const IDLE_CLICK_GAP_MS = 60_000;
export const TOUCH_VIEWPORT_MAX_W = 900;
const STRAIGHTNESS_WINDOW = 6;
const HEADING_BINS = 12;

const WEIGHTS: Record<ComponentKey, number> = {
  straightness: 0.3,
  speedCv: 0.2,
  headingEntropy: 0.2,
  clicksWithoutApproach: 0.2,
  clickIntervalCv: 0.1,
};

const REASON_LABELS: Record<ComponentKey, string> = {
  straightness: "straight_line_movement",
  speedCv: "constant_speed_movement",
  headingEntropy: "low_heading_variety",
  clicksWithoutApproach: "clicks_without_pointer_approach",
  clickIntervalCv: "metronomic_click_timing",
};

// A component fires (>= 0.7) at these thresholds — surfaced as reasons.
const REASON_THRESHOLD = 0.7;

function dist(a: MouseSample, b: MouseSample): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function mean(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function stddev(xs: number[], m: number): number {
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / xs.length);
}

// Coefficient of variation; null when the mean is not positive or there
// are too few samples for a spread to mean anything.
function cv(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  if (!(m > 0)) return null;
  return stddev(xs, m) / m;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// Normalised Shannon entropy of angles binned over (-pi, pi].
function headingEntropyOf(angles: number[]): number {
  const bins = new Array<number>(HEADING_BINS).fill(0);
  for (const a of angles) {
    // Map (-pi, pi] -> [0, BINS)
    let idx = Math.floor(((a + Math.PI) / (2 * Math.PI)) * HEADING_BINS);
    if (idx >= HEADING_BINS) idx = HEADING_BINS - 1;
    if (idx < 0) idx = 0;
    bins[idx]! += 1;
  }
  let h = 0;
  for (const n of bins) {
    if (n === 0) continue;
    const p = n / angles.length;
    h -= p * Math.log(p);
  }
  return h / Math.log(HEADING_BINS);
}

// Linear ramp: 1 when x <= one, 0 when x >= zero (low value = suspicious).
function suspicionLow(x: number, one: number, zero: number): number {
  if (x <= one) return 1;
  if (x >= zero) return 0;
  return (zero - x) / (zero - one);
}

// Linear ramp: 0 when x <= zero, 1 when x >= one (high value = suspicious).
function suspicionHigh(x: number, zero: number, one: number): number {
  if (x >= one) return 1;
  if (x <= zero) return 0;
  return (x - zero) / (one - zero);
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function extractFeatures(signals: SessionSignals): BehaviourFeatures {
  const segments = signals.segments
    .map((s) => [...s].sort((a, b) => a.t - b.t))
    .filter((s) => s.length >= 2);
  let points = 0;
  for (const s of segments) points += s.length;
  const clicks = [...signals.clicks].sort((a, b) => a.t - b.t);

  const touchLike =
    points === 0 &&
    signals.viewportW != null &&
    signals.viewportW > 0 &&
    signals.viewportW < TOUCH_VIEWPORT_MAX_W;

  // ── Trajectory features ───────────────────────────────────────────
  const ratios: number[] = [];
  const speeds: number[] = [];
  const headings: number[] = [];
  for (const seg of segments) {
    for (let i = 0; i + 1 < seg.length; i += 1) {
      const a = seg[i]!;
      const b = seg[i + 1]!;
      const d = dist(a, b);
      const dt = b.t - a.t;
      if (dt > 0 && d > 0) speeds.push(d / dt);
    }
    for (let i = 0; i + STRAIGHTNESS_WINDOW - 1 < seg.length; i += 1) {
      let path = 0;
      for (let j = i; j + 1 < i + STRAIGHTNESS_WINDOW; j += 1) {
        path += dist(seg[j]!, seg[j + 1]!);
      }
      if (path > 0) {
        ratios.push(dist(seg[i]!, seg[i + STRAIGHTNESS_WINDOW - 1]!) / path);
      }
    }
    for (let i = 1; i + 1 < seg.length; i += 1) {
      const p0 = seg[i - 1]!;
      const p1 = seg[i]!;
      const p2 = seg[i + 1]!;
      const v1x = p1.x - p0.x;
      const v1y = p1.y - p0.y;
      const v2x = p2.x - p1.x;
      const v2y = p2.y - p1.y;
      if ((v1x === 0 && v1y === 0) || (v2x === 0 && v2y === 0)) continue;
      const cross = v1x * v2y - v1y * v2x;
      const dot = v1x * v2x + v1y * v2y;
      headings.push(Math.atan2(cross, dot));
    }
  }
  const enoughTrajectory = points >= MIN_TRAJECTORY_POINTS;
  const straightness =
    enoughTrajectory && ratios.length >= 5 ? mean(ratios) : null;
  const speedCv = enoughTrajectory && speeds.length >= 10 ? cv(speeds) : null;
  const headingEntropy =
    enoughTrajectory && headings.length >= 10 ? headingEntropyOf(headings) : null;

  // ── Click approach ────────────────────────────────────────────────
  let clicksWithoutApproach: number | null = null;
  if (clicks.length >= MIN_CLICKS_FOR_APPROACH) {
    if (points === 0) {
      clicksWithoutApproach = touchLike ? null : 1;
    } else {
      const times: number[] = [];
      for (const seg of segments) for (const p of seg) times.push(p.t);
      times.sort((a, b) => a - b);
      let without = 0;
      for (const c of clicks) {
        // First sample at or after (c.t - window); approached if it is <= c.t.
        const lo = c.t - APPROACH_WINDOW_MS;
        let l = 0;
        let r = times.length;
        while (l < r) {
          const m = (l + r) >> 1;
          if (times[m]! < lo) l = m + 1;
          else r = m;
        }
        const approached = l < times.length && times[l]! <= c.t;
        if (!approached) without += 1;
      }
      clicksWithoutApproach = without / clicks.length;
    }
  }

  // ── Click rhythm ──────────────────────────────────────────────────
  const intervals: number[] = [];
  for (let i = 1; i < clicks.length; i += 1) {
    const gap = clicks[i]!.t - clicks[i - 1]!.t;
    if (gap > 0 && gap <= IDLE_CLICK_GAP_MS) intervals.push(gap);
  }
  const clickIntervalCv =
    intervals.length >= MIN_CLICK_INTERVALS ? cv(intervals) : null;
  const medianClickIntervalMs = intervals.length > 0 ? median(intervals) : null;

  return {
    points,
    clicks: clicks.length,
    straightness: straightness == null ? null : round3(straightness),
    speedCv: speedCv == null ? null : round3(speedCv),
    headingEntropy: headingEntropy == null ? null : round3(headingEntropy),
    clicksWithoutApproach:
      clicksWithoutApproach == null ? null : round3(clicksWithoutApproach),
    clickIntervalCv: clickIntervalCv == null ? null : round3(clickIntervalCv),
    medianClickIntervalMs:
      medianClickIntervalMs == null ? null : Math.round(medianClickIntervalMs),
    touchLike,
  };
}

export function scoreFeatures(f: BehaviourFeatures): BehaviourScore {
  const components: Partial<Record<ComponentKey, number>> = {};
  if (f.straightness != null) {
    components.straightness = suspicionHigh(f.straightness, 0.94, 0.995);
  }
  if (f.speedCv != null) {
    components.speedCv = suspicionLow(f.speedCv, 0.2, 0.55);
  }
  if (f.headingEntropy != null) {
    components.headingEntropy = suspicionLow(f.headingEntropy, 0.3, 0.65);
  }
  if (f.clicksWithoutApproach != null) {
    components.clicksWithoutApproach = suspicionHigh(
      f.clicksWithoutApproach,
      0.25,
      0.8,
    );
  }
  if (f.clickIntervalCv != null) {
    components.clickIntervalCv = suspicionLow(f.clickIntervalCv, 0.2, 0.7);
  }

  const keys = Object.keys(components) as ComponentKey[];
  if (keys.length < 2) {
    return { score: null, components, reasons: [] };
  }
  let num = 0;
  let den = 0;
  const reasons: string[] = [];
  for (const k of keys) {
    const v = components[k]!;
    components[k] = round3(v);
    num += v * WEIGHTS[k];
    den += WEIGHTS[k];
    if (v >= REASON_THRESHOLD) reasons.push(REASON_LABELS[k]);
  }
  return { score: round3(num / den), components, reasons };
}

export function scoreSession(signals: SessionSignals): {
  features: BehaviourFeatures;
  result: BehaviourScore;
} {
  const features = extractFeatures(signals);
  return { features, result: scoreFeatures(features) };
}

// ── Per-bettor rollup ─────────────────────────────────────────────────

export interface SessionScoreInput {
  score: number;
  // Sample count — heavier sessions carry more weight, capped so one
  // marathon session can't dominate the average.
  points: number;
}

export interface ConfirmTimeInput {
  // Tickets with a recorded quote -> place gap.
  n: number;
  // Share of those inside (min_human_ms + 150 ms) — i.e. confirmed as
  // fast as the rules allow. Humans spread; scripts sit on the floor.
  fastShare: number;
}

export const MIN_CONFIRM_SAMPLES = 10;
const CONFIRM_WEIGHT = 0.2;

export function combineUserScore(
  sessions: SessionScoreInput[],
  confirm: ConfirmTimeInput | null,
): number | null {
  let num = 0;
  let den = 0;
  for (const s of sessions) {
    if (!Number.isFinite(s.score)) continue;
    const w = Math.min(Math.max(s.points, 0), 2000) + 1;
    num += s.score * w;
    den += w;
  }
  const behaviour = den > 0 ? num / den : null;
  const confirmComponent =
    confirm && confirm.n >= MIN_CONFIRM_SAMPLES
      ? suspicionHigh(confirm.fastShare, 0.3, 0.9)
      : null;
  if (behaviour == null && confirmComponent == null) return null;
  if (behaviour == null) {
    // Confirm-time alone is too thin to raise an alert on its own; it
    // still contributes a small score so the profile shows movement.
    return round3(confirmComponent! * CONFIRM_WEIGHT);
  }
  if (confirmComponent == null) return round3(behaviour);
  return round3(behaviour * (1 - CONFIRM_WEIGHT) + confirmComponent * CONFIRM_WEIGHT);
}

// Alert state machine with hysteresis so a bettor hovering around the
// threshold does not flap between alert / clear on every sweep.
export const ALERT_HYSTERESIS = 0.1;

export function resolveAlert(input: {
  score: number | null;
  sessionsScored: number;
  threshold: number;
  minSessions: number;
  wasAlert: boolean;
}): boolean {
  if (input.score == null) return false;
  if (input.sessionsScored < input.minSessions) return false;
  if (input.wasAlert) return input.score >= input.threshold - ALERT_HYSTERESIS;
  return input.score >= input.threshold;
}
