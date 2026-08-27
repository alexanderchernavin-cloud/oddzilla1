import { test } from "node:test";
import assert from "node:assert/strict";

import { formatOddsDisplay, ODDS_PLACEHOLDER } from "./odds.js";

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
