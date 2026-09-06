import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  bookKey,
  priceCustomMarket,
  MIN_CUSTOM_PROBABILITY,
} from "./custom-events.js";

const off = { enabled: false, strengthBp: 0, maxShiftBp: 0 };

test("a fair book with no overround prices at 1/p", () => {
  const cells = priceCustomMarket({
    outcomes: [
      { outcomeId: "1", baseProbability: 0.5 },
      { outcomeId: "2", baseProbability: 0.5 },
    ],
    overroundBp: 0,
    liability: off,
  });
  assert.equal(cells[0]!.publishedOdds, 2);
  assert.equal(cells[1]!.publishedOdds, 2);
  assert.ok(Math.abs(bookKey(cells.map((c) => c.publishedOdds)) - 1) < 1e-9);
});

test("the overround lands on the book key, not on one price", () => {
  const cells = priceCustomMarket({
    outcomes: [
      { outcomeId: "1", baseProbability: 0.6 },
      { outcomeId: "2", baseProbability: 0.25 },
      { outcomeId: "3", baseProbability: 0.15 },
    ],
    overroundBp: 500,
    liability: off,
  });
  const key = bookKey(cells.map((c) => c.publishedOdds));
  // Prices round DOWN to the 4dp grid, so the delivered key sits a hair
  // ABOVE the requested 1.05 — never below, which would be margin we
  // asked for and did not take.
  assert.ok(key >= 1.05, `key ${key} must not undercut the requested 5%`);
  assert.ok(key < 1.0502, `key ${key} should be 1.05 up to rounding`);
});

test("operator probabilities are normalised, not rejected", () => {
  // 60/30/20 sums to 110 — what a human actually types.
  const cells = priceCustomMarket({
    outcomes: [
      { outcomeId: "1", baseProbability: 60 },
      { outcomeId: "2", baseProbability: 30 },
      { outcomeId: "3", baseProbability: 20 },
    ],
    overroundBp: 0,
    liability: off,
  });
  const sum = cells.reduce((a, c) => a + c.baseProbability, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(Math.abs(cells[0]!.baseProbability - 60 / 110) < 1e-9);
});

test("prices round DOWN so a stored price is never longer than the model", () => {
  const cells = priceCustomMarket({
    outcomes: [
      { outcomeId: "1", baseProbability: 1 / 3 },
      { outcomeId: "2", baseProbability: 2 / 3 },
    ],
    overroundBp: 0,
    liability: off,
  });
  // 1/(1/3) = 3 exactly; 1/(2/3) = 1.5 exactly. Use a ratio that does not
  // land on the grid to see the direction.
  const odd = priceCustomMarket({
    outcomes: [
      { outcomeId: "1", baseProbability: 0.37 },
      { outcomeId: "2", baseProbability: 0.63 },
    ],
    overroundBp: 0,
    liability: off,
  });
  assert.equal(cells[0]!.publishedOdds, 3);
  const exact = 1 / 0.37;
  assert.ok(odd[0]!.publishedOdds <= exact);
  assert.ok(exact - odd[0]!.publishedOdds < 0.0001);
});

test("liability trading shortens the side carrying the money", () => {
  const cells = priceCustomMarket({
    outcomes: [
      { outcomeId: "1", baseProbability: 0.5, exposureMicro: 900_000_000 },
      { outcomeId: "2", baseProbability: 0.5, exposureMicro: 100_000_000 },
    ],
    overroundBp: 0,
    liability: { enabled: true, strengthBp: 5000, maxShiftBp: 10_000 },
  });
  // Money is 90/10 on outcome 1, so its probability rises and its price
  // falls; outcome 2 gets longer. That is the balancing direction.
  assert.ok(cells[0]!.probability > 0.5);
  assert.ok(cells[1]!.probability < 0.5);
  assert.ok(cells[0]!.publishedOdds < 2);
  assert.ok(cells[1]!.publishedOdds > 2);
  assert.ok(cells[0]!.shiftBp > 0);
  assert.ok(cells[1]!.shiftBp < 0);
  // Half way to a 90/10 money split from a 50/50 base is 70/30.
  assert.ok(Math.abs(cells[0]!.probability - 0.7) < 1e-9);
});

test("liability trading is a no-op until money arrives", () => {
  const on = priceCustomMarket({
    outcomes: [
      { outcomeId: "1", baseProbability: 0.4 },
      { outcomeId: "2", baseProbability: 0.6 },
    ],
    overroundBp: 300,
    liability: { enabled: true, strengthBp: 8000, maxShiftBp: 2000 },
  });
  const offCells = priceCustomMarket({
    outcomes: [
      { outcomeId: "1", baseProbability: 0.4 },
      { outcomeId: "2", baseProbability: 0.6 },
    ],
    overroundBp: 300,
    liability: off,
  });
  assert.deepEqual(
    on.map((c) => c.publishedOdds),
    offCells.map((c) => c.publishedOdds),
  );
  assert.ok(on.every((c) => c.shiftBp === 0));
});

test("strength 0 prices exactly as trading disabled", () => {
  const outcomes = [
    { outcomeId: "1", baseProbability: 0.45, exposureMicro: 5_000_000 },
    { outcomeId: "2", baseProbability: 0.55, exposureMicro: 1_000_000 },
  ];
  const a = priceCustomMarket({ outcomes, overroundBp: 400, liability: { enabled: true, strengthBp: 0, maxShiftBp: 5000 } });
  const b = priceCustomMarket({ outcomes, overroundBp: 400, liability: off });
  assert.deepEqual(a.map((c) => c.publishedOdds), b.map((c) => c.publishedOdds));
});

test("maxShift keeps one big bet from walking the price off a cliff", () => {
  const capped = priceCustomMarket({
    outcomes: [
      { outcomeId: "1", baseProbability: 0.5, exposureMicro: 1_000_000_000 },
      { outcomeId: "2", baseProbability: 0.5, exposureMicro: 0 },
    ],
    overroundBp: 0,
    // All the money on one side at full strength would drive it to ~1.0;
    // the 5pp cap stops it near 0.55.
    liability: { enabled: true, strengthBp: 10_000, maxShiftBp: 500 },
  });
  assert.ok(capped[0]!.probability < 0.58, `got ${capped[0]!.probability}`);
  assert.ok(capped[0]!.probability > 0.5);
});

test("an outcome with all the money still gets a bettable price", () => {
  const cells = priceCustomMarket({
    outcomes: [
      { outcomeId: "1", baseProbability: 0.5, exposureMicro: 1 },
      { outcomeId: "2", baseProbability: 0.5, exposureMicro: 0 },
    ],
    overroundBp: 0,
    liability: { enabled: true, strengthBp: 10_000, maxShiftBp: 10_000 },
  });
  // Outcome 2 is floored, not zeroed, so its price stays finite and
  // storable rather than dividing by zero.
  assert.ok(cells[1]!.probability >= MIN_CUSTOM_PROBABILITY);
  assert.ok(Number.isFinite(cells[1]!.publishedOdds));
  assert.ok(cells[1]!.publishedOdds <= 10_000);
});

test("bad operator input throws rather than being silently repaired", () => {
  assert.throws(() =>
    priceCustomMarket({
      outcomes: [{ outcomeId: "1", baseProbability: 1 }],
      overroundBp: 0,
    }),
  );
  assert.throws(() =>
    priceCustomMarket({
      outcomes: [
        { outcomeId: "1", baseProbability: 0 },
        { outcomeId: "2", baseProbability: 1 },
      ],
      overroundBp: 0,
    }),
  );
});
