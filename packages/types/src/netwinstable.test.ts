import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyNetwinstableKey,
  bookKey,
  boostMarketKey,
  boostSelectionKeys,
  SELECTION_BOOST_MAX_PROB_SHARE,
} from "./netwinstable.js";

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

test("bookKey sums inverse odds", () => {
  assert.ok(close(bookKey([2, 2]), 1.0));
  assert.ok(close(bookKey([1.95, 1.95]), 1 / 1.95 + 1 / 1.95));
  assert.ok(close(bookKey([2, 3, 6]), 1));
});

test("two-outcome lowering the key keeps the netwin ratio", () => {
  // Original 1.91 / 1.91 → key ≈ 1.0471 (≈4.7% margin).
  // Target lower key by 0.03 → 1.0171.
  const original = [1.91, 1.91];
  const adjusted = applyNetwinstableKey(original, 1.0171);
  assert.ok(close(1 / adjusted[0]! + 1 / adjusted[1]!, 1.0171, 1e-6));
  assert.ok(close(adjusted[0]!, adjusted[1]!, 1e-6));
  assert.ok(adjusted[0]! > 1.91);
});

test("two-outcome asymmetric: netwin ratio preserved", () => {
  const original = [1.5, 3.0];
  const target = bookKey(original) - 0.05;
  const adjusted = applyNetwinstableKey(original, target);
  const sum = 1 / adjusted[0]! + 1 / adjusted[1]!;
  assert.ok(close(sum, target, 1e-6));
  const ratioOrig = (original[0]! - 1) / (original[1]! - 1);
  const ratioAdj = (adjusted[0]! - 1) / (adjusted[1]! - 1);
  assert.ok(close(ratioOrig, ratioAdj, 1e-6));
});

test("three-outcome 1X2: netwin ratios preserved across all pairs", () => {
  const original = [2.4, 3.4, 3.1];
  const target = bookKey(original) - 0.04;
  const adjusted = applyNetwinstableKey(original, target);
  assert.ok(
    close(1 / adjusted[0]! + 1 / adjusted[1]! + 1 / adjusted[2]!, target, 1e-6),
  );
  const r01o = (original[0]! - 1) / (original[1]! - 1);
  const r01a = (adjusted[0]! - 1) / (adjusted[1]! - 1);
  const r02o = (original[0]! - 1) / (original[2]! - 1);
  const r02a = (adjusted[0]! - 1) / (adjusted[2]! - 1);
  assert.ok(close(r01o, r01a, 1e-6));
  assert.ok(close(r02o, r02a, 1e-6));
});

test("boostMarketKey returns no-op when fair book", () => {
  const original = [2.0, 2.0];
  const r = boostMarketKey(original, 3);
  assert.equal(r.effectiveKeyDelta, 0);
  assert.deepEqual(r.adjustedOdds, [2.0, 2.0]);
});

test("boostMarketKey clamps to a no-better-than-fair book", () => {
  // Original key 1.02 (very tight), asking for -5pp would push us into
  // a player-positive book → clamp at key=1.0 (fair).
  const original = [1.96, 2.04];
  const r = boostMarketKey(original, 5);
  assert.equal(r.keyAdjusted, 1.0);
  assert.ok(
    close(1 / r.adjustedOdds[0]! + 1 / r.adjustedOdds[1]!, 1.0, 1e-6),
  );
});

test("handles NaN / invalid outcomes by leaving them untouched", () => {
  const original = [2.0, Number.NaN, 4.0];
  const adjusted = applyNetwinstableKey(original, 0.6);
  assert.ok(Number.isNaN(adjusted[1]!));
  assert.ok(close(1 / adjusted[0]! + 1 / adjusted[2]!, 0.6, 1e-6));
});

test("monotonic: lowering the key strictly raises every outcome", () => {
  const original = [1.7, 2.4, 5.5];
  const r1 = boostMarketKey(original, 1);
  const r3 = boostMarketKey(original, 3);
  for (let i = 0; i < 3; i++) {
    assert.ok(r1.adjustedOdds[i]! > original[i]!);
    assert.ok(r3.adjustedOdds[i]! > r1.adjustedOdds[i]!);
  }
});

// ── boostSelectionKeys (per-selection boosts) ───────────────────────

test("boostSelectionKeys moves only the boosted outcome", () => {
  const original = [1.91, 1.91];
  const r = boostSelectionKeys(original, [2, 0]);
  assert.ok(r.adjustedOdds[0]! > original[0]!);
  assert.equal(r.adjustedOdds[1], original[1]);
  assert.equal(r.effectiveDeltas[1], 0);
  // The delta comes straight out of the boosted leg's probability.
  assert.ok(close(1 / original[0]! - 1 / r.adjustedOdds[0]!, 0.02, 1e-9));
  assert.ok(close(r.keyAdjusted, r.keyOriginal - 0.02, 1e-9));
});

test("boostSelectionKeys no-ops on a fair or better book", () => {
  const r = boostSelectionKeys([2.0, 2.0], [3, 0]);
  assert.equal(r.effectiveKeyDelta, 0);
  assert.deepEqual(r.adjustedOdds, [2.0, 2.0]);
});

test("boostSelectionKeys never takes the book past fair", () => {
  // Key 1.02 — asking 5pp out of one leg would leave a player-positive
  // book, so the applied delta is clamped to the 0.02 of headroom.
  const original = [1.96, 2.04];
  const keyOriginal = bookKey(original);
  const r = boostSelectionKeys(original, [5, 0]);
  assert.ok(close(r.keyAdjusted, 1.0, 1e-9));
  assert.ok(close(r.effectiveKeyDelta, keyOriginal - 1.0, 1e-9));
  assert.ok(
    close(1 / r.adjustedOdds[0]! + 1 / r.adjustedOdds[1]!, 1.0, 1e-9),
  );
});

test("boostSelectionKeys caps a longshot at the probability share", () => {
  // Key 1.05, so 5pp of headroom is available — but the boosted leg's
  // own probability is only 0.05. Without the per-outcome cap a 5pp
  // request would zero it out and send the price to infinity.
  const original = [1.5, 3.0, 20.0];
  const r = boostSelectionKeys(original, [0, 0, 5]);
  const p = 1 / original[2]!;
  assert.ok(
    close(r.effectiveDeltas[2]!, p * SELECTION_BOOST_MAX_PROB_SHARE, 1e-9),
  );
  assert.ok(Number.isFinite(r.adjustedOdds[2]!));
  // Half the probability shaved <=> exactly double the price.
  assert.ok(
    close(
      r.adjustedOdds[2]!,
      original[2]! / SELECTION_BOOST_MAX_PROB_SHARE,
      1e-6,
    ),
  );
  // Still a positive-margin book.
  assert.ok(r.keyAdjusted > 1.0);
});

test("boostSelectionKeys shares scarce headroom proportionally", () => {
  // Two 5pp requests against ~4.7pp of headroom: both scale by the
  // same factor rather than the first one consuming it all.
  const original = [1.91, 1.91];
  const keyOriginal = bookKey(original);
  const r = boostSelectionKeys(original, [5, 5]);
  assert.ok(close(r.effectiveKeyDelta, keyOriginal - 1.0, 1e-9));
  assert.ok(close(r.effectiveDeltas[0]!, r.effectiveDeltas[1]!, 1e-12));
});

test("boostSelectionKeys is order-independent across selections", () => {
  const original = [1.4, 4.5, 6.0];
  const a = boostSelectionKeys(original, [2, 3, 0]);
  const b = boostSelectionKeys([...original].reverse(), [0, 3, 2]);
  assert.ok(close(a.effectiveKeyDelta, b.effectiveKeyDelta, 1e-12));
  assert.ok(close(a.adjustedOdds[0]!, b.adjustedOdds[2]!, 1e-12));
  assert.ok(close(a.adjustedOdds[1]!, b.adjustedOdds[1]!, 1e-12));
});

test("boostSelectionKeys skips outcomes at exactly 1.00", () => {
  // A live favorite ticking through 1.00 carries no key to give back;
  // it must pass through untouched rather than produce a bad price.
  const r = boostSelectionKeys([1.0, 3.0], [3, 0]);
  assert.equal(r.adjustedOdds[0], 1.0);
  assert.equal(r.effectiveKeyDelta, 0);
});
