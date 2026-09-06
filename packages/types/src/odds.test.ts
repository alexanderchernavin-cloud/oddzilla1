import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatOddsDisplay,
  isBettableOdds,
  ladderStep,
  quoteOnLadder,
  LADDER_FLOOR,
  ODDS_PLACEHOLDER,
} from "./odds.js";
import { quoteOnLadder as customQuoteOnLadder } from "./custom-events.js";

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

test("quotes an ordinary price on the 0.01 ladder", () => {
  // The reported bug, from a live CS2 map on 2026-09-06: the map-3
  // winner shipped as 5.1410 / 3.6860 and the map-3 threeway as
  // 1.3095 / 5.1410. Nobody chose those digits — they are the feed's
  // arithmetic rendered verbatim, and no book prints them.
  assert.equal(formatOddsDisplay(5.141), "5.14");
  assert.equal(formatOddsDisplay(3.686), "3.68");
  assert.equal(formatOddsDisplay(1.1834), "1.18");
  assert.equal(formatOddsDisplay(1.3095), "1.30");
  // Already on a rung: unchanged.
  assert.equal(formatOddsDisplay(9.7), "9.70");
  assert.equal(formatOddsDisplay(3.45), "3.45");
});

test("keeps full precision below the ladder floor", () => {
  // The case this module exists for, and the half the operator
  // confirmed was right: a near-certain live favorite at 1.003 has no
  // rung to land on — 1.00 is unbettable and 1.01 is longer than the
  // feed said — so it keeps every digit.
  assert.equal(formatOddsDisplay(1.001), "1.001");
  assert.equal(formatOddsDisplay(1.003), "1.003");
  assert.equal(formatOddsDisplay(1.0037), "1.0037");
  assert.equal(formatOddsDisplay(1.004), "1.004");
  assert.equal(formatOddsDisplay(1.0099), "1.0099");
  // Exactly at the floor the ladder takes over.
  assert.equal(formatOddsDisplay(LADDER_FLOOR), "1.01");
});

test("the ladder coarsens as the price lengthens", () => {
  assert.equal(ladderStep(5), 0.01);
  assert.equal(ladderStep(15), 0.1);
  assert.equal(ladderStep(30), 0.5);
  assert.equal(ladderStep(70), 1);
  assert.equal(ladderStep(500), 5);
  assert.equal(formatOddsDisplay(1.9999), "1.99");
  assert.equal(formatOddsDisplay(13.47), "13.40");
  assert.equal(formatOddsDisplay(23.7), "23.50");
  assert.equal(formatOddsDisplay(76.4), "76.00");
  assert.equal(formatOddsDisplay(163), "160.00");
});

test("floors rather than rounds — a price only moves toward the house", () => {
  // Never up onto the next rung: the bettor is quoted no more than the
  // feed said, which is the convention every odds path here follows.
  assert.equal(formatOddsDisplay(2.9999999), "2.99");
  assert.equal(formatOddsDisplay(7.579), "7.57");
  // Below the floor the 4dp truncation still absorbs float64
  // representation error: 1.003 is 1.0029999999999999 as a double, and
  // a bare truncation would emit "1.002".
  assert.equal(formatOddsDisplay(1.0029999999999999), "1.003");
  assert.equal(formatOddsDisplay(1.00299), "1.0029");
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

test("the ladder is idempotent", () => {
  // The publisher quotes onto the ladder before storing, and every
  // reader ladders again. That is only safe if a second pass is a
  // no-op.
  for (let cents = 100; cents <= 30000; cents += 7) {
    const n = cents / 100;
    const once = quoteOnLadder(n);
    assert.equal(quoteOnLadder(once), once, `not idempotent at ${n}`);
  }
});

test("matches the custom-events ladder rung for rung", () => {
  // Operator-authored prices have been quoted on this ladder since
  // 2026-09-06. Feed prices join it here, and the two implementations
  // are duplicated rather than shared because both modules are pulled
  // into apps/web as values and must stay free of relative imports.
  // This is what stops them drifting.
  //
  // Scoped to >= LADDER_FLOOR: below it the two deliberately differ.
  // This module absorbs the publisher's big.Float artefact with a
  // scaled epsilon, custom-events has no such input and floors bare.
  for (let units = 10100; units <= 2_000_000; units += 137) {
    const n = units / 10000;
    assert.equal(
      quoteOnLadder(n),
      customQuoteOnLadder(n),
      `ladder mismatch at ${n}`,
    );
  }
});

test("matches the api payload formatter on the values it ships", () => {
  // Parity with `formatOdds` in services/api/src/modules/catalog/routes.ts
  // — the storefront must render exactly the string the API computed,
  // or the displayed price and the drift reference diverge.
  const apiFormatOdds = (s: string): string | null => {
    const n = Number.parseFloat(s);
    if (!Number.isFinite(n) || n < 0) return null;
    const units = Math.floor(quoteOnLadder(n) * 10000 + 1e-6);
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
    "5.1410",
    "3.6860",
    "1.1834",
    "1.3095",
    "23.7000",
    "101.0000",
  ]) {
    assert.equal(
      formatOddsDisplay(Number.parseFloat(raw)),
      apiFormatOdds(raw),
      `mismatch on ${raw}`,
    );
  }
});

test("matches the Go publisher's integer-domain ladder", () => {
  // services/odds-publisher renders through big.Float and therefore
  // ladders in units of 1e-4 with exact integer division, while this
  // module ladders the float directly. The publisher's string IS
  // `published_odds`, so a divergence would put an off-rung price in
  // the database and a laddered one on screen.
  const goLadderUnits = (units: number): number => {
    if (units < 10100) return units;
    let step: number;
    if (units < 100000) step = 100;
    else if (units < 200000) step = 1000;
    else if (units < 500000) step = 5000;
    else if (units < 1000000) step = 10000;
    else step = 50000;
    return Math.floor(units / step) * step;
  };
  for (let units = 1; units <= 2_000_000; units += 89) {
    const n = units / 10000;
    const mine = Math.floor(quoteOnLadder(n) * 10000 + 1e-6);
    assert.equal(mine, goLadderUnits(units), `go/ts ladder mismatch at ${n}`);
  }
});
