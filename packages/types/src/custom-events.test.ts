import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  bookKey,
  formatEventTitle,
  priceCustomMarket,
  LADDER_FLOOR,
  MIN_CUSTOM_PROBABILITY,
  ladderStep,
  quoteOnLadder,
} from "./custom-events.js";

test("a question renders its title alone, never a dangling vs", () => {
  // The empty second side IS the marker: `matches` has two NOT NULL team
  // columns, and a question has one subject.
  assert.equal(
    formatEventTitle("Dima and Nastya to unite again", ""),
    "Dima and Nastya to unite again",
  );
  assert.equal(formatEventTitle("Who wins the election", "   "), "Who wins the election");
  assert.equal(formatEventTitle("Who wins", null), "Who wins");
  assert.equal(formatEventTitle("Who wins", undefined), "Who wins");
});

test("a match-up still reads as one", () => {
  assert.equal(formatEventTitle("Astralis", "NAVI"), "Astralis vs NAVI");
});

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
  // Every price is floored onto the 0.01 ladder, so the delivered key
  // sits ABOVE the requested 1.05 — never below, which would be margin
  // we asked for and did not take. One hundredth per outcome is the
  // whole budget for the gap.
  assert.ok(key >= 1.05, `key ${key} must not undercut the requested 5%`);
  assert.ok(key < 1.06, `key ${key} drifted further than the ladder step`);
});

test("authored prices are quoted on a rung, not at feed precision", () => {
  // The book that shipped as 4.7619 / 1.1904 on the storefront.
  const cells = priceCustomMarket({
    outcomes: [
      { outcomeId: "1", baseProbability: 20 },
      { outcomeId: "2", baseProbability: 80 },
    ],
    overroundBp: 500,
    liability: off,
  });
  for (const c of cells) {
    assert.equal(
      Math.round(c.publishedOdds * 100) / 100,
      c.publishedOdds,
      `${c.publishedOdds} carries more than two decimals`,
    );
  }
});

test("the margin goes on by netwin scaling, not by dividing every price", () => {
  // Betradar's Netwinstable Key Adjustment: every NET WIN scales by one
  // factor, so the longer price gives up more than proportionally and
  // the shorter one less. Proportional division would have quoted
  // 4.76 / 1.19 here.
  const cells = priceCustomMarket({
    outcomes: [
      { outcomeId: "1", baseProbability: 20 },
      { outcomeId: "2", baseProbability: 80 },
    ],
    overroundBp: 500,
    liability: off,
  });
  assert.equal(cells[0]!.publishedOdds, 4.42);
  assert.equal(cells[1]!.publishedOdds, 1.21);

  // Against the proportional baseline (fair / 1.05 = 4.76 / 1.19): the
  // longer price gives up MORE than proportionally and the shorter one
  // LESS. That direction is the whole algorithm.
  assert.ok(cells[0]!.publishedOdds < 4.76, "the long side should give up more");
  assert.ok(cells[1]!.publishedOdds > 1.19, "the short side should give up less");

  // The ratio of net wins survives — approximately, because the ladder
  // then moves each price onto a rung, and at 1.21 a hundredth is ~5% of
  // that outcome's whole net win. The exact invariant belongs to
  // applyNetwinstableKey; what this pins is that it reaches here.
  const fairRatio = (5.0 - 1) / (1.25 - 1);
  const quotedRatio =
    (cells[0]!.publishedOdds - 1) / (cells[1]!.publishedOdds - 1);
  assert.ok(
    Math.abs(quotedRatio / fairRatio - 1) < 0.03,
    `netwin ratio moved too far: ${quotedRatio} vs ${fairRatio}`,
  );
});

test("a long shot is not quoted at an absurd price to fund a 10% key", () => {
  // The five-way book an operator built on production. Proportional put
  // the 1% shots at 90.90 and the favourite at 1.06; Netwinstable takes
  // the margin off the tail instead, where the money is not.
  const cells = priceCustomMarket({
    outcomes: [
      { outcomeId: "1", baseProbability: 85 },
      { outcomeId: "2", baseProbability: 12 },
      { outcomeId: "3", baseProbability: 1 },
      { outcomeId: "4", baseProbability: 1 },
      { outcomeId: "5", baseProbability: 1 },
    ],
    overroundBp: 1000,
    liability: off,
  });
  assert.ok(cells[0]!.publishedOdds > 1.1, `favourite at ${cells[0]!.publishedOdds}`);
  assert.ok(cells[2]!.publishedOdds < 75, `long shot at ${cells[2]!.publishedOdds}`);
  const key = bookKey(cells.map((c) => c.publishedOdds));
  assert.ok(key >= 1.1 && key < 1.12, `key ${key}`);
});

test("no price can be driven under 1.0, the failure the doc opens with", () => {
  // "How would you apply a key of 110 to a fair odds of 1.05 without
  // resulting in odds lower than 1.0?" Proportional cannot; scaling net
  // wins by a positive factor can never reach 1.0 at all.
  const cells = priceCustomMarket({
    outcomes: [
      { outcomeId: "1", baseProbability: 95.238 },
      { outcomeId: "2", baseProbability: 4.762 },
    ],
    overroundBp: 1000,
    liability: off,
  });
  for (const c of cells) {
    assert.ok(c.publishedOdds > 1, `${c.publishedOdds} is not a bettable price`);
  }
});

test("the ladder step widens with the price", () => {
  // A flat hundredth is right near evens and ridiculous in the tail: a
  // 1% shot priced 90.909 came out as 90.90, which no book prints.
  assert.equal(quoteOnLadder(1.0695), 1.06);
  assert.equal(quoteOnLadder(7.5757), 7.57);
  assert.equal(quoteOnLadder(12.34), 12.3);
  assert.equal(quoteOnLadder(37.9), 37.5);
  assert.equal(quoteOnLadder(90.909), 90);
  assert.equal(quoteOnLadder(637), 635);
});

test("every quoted price sits exactly on a rung", () => {
  for (const raw of [1.0695, 3.333, 7.5757, 12.34, 24.7, 37.9, 90.909, 637]) {
    const q = quoteOnLadder(raw);
    const step = ladderStep(raw);
    // Float dust must not leave a value a hair off its own rung — 73 *
    // 0.1 is 7.300000000000001, and 7.57 / 0.01 is 756.9999999999999.
    assert.ok(
      Math.abs(q / step - Math.round(q / step)) < 1e-6,
      `${q} is not a multiple of ${step}`,
    );
    assert.ok(q <= raw, `${q} lengthened past the model's ${raw}`);
  }
});

test("the ladder floors, so a price never lengthens past the model", () => {
  const cells = priceCustomMarket({
    outcomes: [
      { outcomeId: "1", baseProbability: 0.37 },
      { outcomeId: "2", baseProbability: 0.63 },
    ],
    overroundBp: 0,
    liability: off,
  });
  // 1/0.37 = 2.7027 -> 2.70, not 2.71.
  assert.equal(cells[0]!.publishedOdds, 2.7);
  assert.ok(cells[0]!.publishedOdds <= 1 / 0.37);
});

test("below 1.01 the ladder gives way, because it cannot express the price", () => {
  // A 99.5% favorite prices at 1.005. Two decimals would either kill the
  // cell (1.00 is unbettable) or lengthen it to 1.01.
  const cells = priceCustomMarket({
    outcomes: [
      { outcomeId: "1", baseProbability: 0.995 },
      { outcomeId: "2", baseProbability: 0.005 },
    ],
    overroundBp: 0,
    liability: off,
  });
  assert.ok(cells[0]!.publishedOdds > 1, "must stay bettable");
  assert.ok(cells[0]!.publishedOdds < LADDER_FLOOR);
  assert.equal(cells[0]!.publishedOdds, 1.005);
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
