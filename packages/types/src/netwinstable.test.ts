import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyNetwinstableKey,
  bookKey,
  boostMarketKey,
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
