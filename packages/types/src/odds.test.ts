import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatOddsDisplay,
  isBettableOdds,
  ODDS_PLACEHOLDER,
} from "./odds.js";

test("sub-1.01 odds above 1.00 are bettable", () => {
  // The operator's call: no 1.01 floor. Oddin quotes a near-certain
  // live favorite this thin and it must render AND place.
  assert.equal(isBettableOdds(1.003), true);
  assert.equal(isBettableOdds(1.001), true);
  assert.equal(isBettableOdds(1.0001), true);
  assert.equal(isBettableOdds(1.01), true);
  assert.equal(isBettableOdds(12), true);
});

test("1.00 and below are displayed but not bettable", () => {
  // Exactly 1.00 returns the stake on a win while carrying full loss
  // and void risk; below 1.00 a winning bet pays less than the stake.
  assert.equal(isBettableOdds(1), false);
  assert.equal(isBettableOdds(0.9552), false);
  assert.equal(isBettableOdds(0), false);
  assert.equal(isBettableOdds(-2), false);
});

test("absent or non-finite prices are not bettable", () => {
  assert.equal(isBettableOdds(null), false);
  assert.equal(isBettableOdds(undefined), false);
  assert.equal(isBettableOdds(Number.NaN), false);
  // Infinity is a pipeline bug, not a 100% payout — refuse it.
  assert.equal(isBettableOdds(Number.POSITIVE_INFINITY), false);
});

test("a locked 1.00 cell still has a formattable price to show", () => {
  // Locked cells render an em dash, but the value must not be mangled
  // if a surface chooses to display it — 1.00 stays "1.00".
  assert.equal(formatOddsDisplay(1), "1.00");
  assert.equal(isBettableOdds(Number.parseFloat("1.00")), false);
  assert.equal(isBettableOdds(Number.parseFloat("1.003")), true);
});

test("trims trailing zeros down to a 2dp floor", () => {
  assert.equal(formatOddsDisplay(1.91), "1.91");
  assert.equal(formatOddsDisplay(1.5), "1.50");
  assert.equal(formatOddsDisplay(2), "2.00");
  assert.equal(formatOddsDisplay(12), "12.00");
});

test("preserves Oddin's native precision past 2dp", () => {
  // The reported bug: a near-certain live favorite priced at 1.003 was
  // rendering as "1.00", indistinguishable from a real 1.0000.
  assert.equal(formatOddsDisplay(1.003), "1.003");
  assert.equal(formatOddsDisplay(1.0037), "1.0037");
  assert.equal(formatOddsDisplay(1.9999), "1.9999");
  assert.equal(formatOddsDisplay(1.004), "1.004");
});

test("floors rather than rounds, absorbing float64 representation error", () => {
  // 1.003 is 1.0029999999999999 as a float64 — a bare truncation would
  // emit "1.002". The scaled epsilon is what makes this land on 1.003.
  assert.equal(formatOddsDisplay(1.0029999999999999), "1.003");
  // Genuinely below the unit: floors down, never up to the next unit.
  assert.equal(formatOddsDisplay(1.00299), "1.0029");
  assert.equal(formatOddsDisplay(2.9999999), "2.9999");
});

test("a true 1.0000 still renders as 1.00, not as a fabricated price", () => {
  // Distinguishing a real 1.0000 from a truncated 1.003 is the whole
  // point — this must NOT be floored up to 1.01.
  assert.equal(formatOddsDisplay(1), "1.00");
  assert.equal(formatOddsDisplay(1.0), "1.00");
});

test("non-finite and negative input yields the placeholder", () => {
  assert.equal(formatOddsDisplay(Number.NaN), ODDS_PLACEHOLDER);
  assert.equal(formatOddsDisplay(Number.POSITIVE_INFINITY), ODDS_PLACEHOLDER);
  assert.equal(formatOddsDisplay(-1.5), ODDS_PLACEHOLDER);
});

test("matches the api payload formatter on the values it ships", () => {
  // Parity with `formatOdds` in services/api/src/modules/catalog/routes.ts
  // — the storefront must render exactly the string the API computed,
  // or the displayed price and the drift reference diverge.
  const apiFormatOdds = (s: string): string | null => {
    const n = Number.parseFloat(s);
    if (!Number.isFinite(n)) return null;
    const units = Math.floor(n * 10000 + 1e-6);
    if (units < 0) return null;
    const intP = Math.floor(units / 10000);
    const frac = units % 10000;
    const padded = `${intP}.${frac.toString().padStart(4, "0")}`;
    return padded.replace(/(\.\d{2})(\d*?)0+$/, "$1$2");
  };
  for (const raw of [
    "1.0000",
    "1.0030",
    "1.0037",
    "1.9100",
    "2.0000",
    "12.0000",
    "1.9999",
    "3.4500",
    "101.0000",
  ]) {
    assert.equal(
      formatOddsDisplay(Number.parseFloat(raw)),
      apiFormatOdds(raw),
      `mismatch on ${raw}`,
    );
  }
});
