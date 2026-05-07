import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMBI_BOOST_MIN_ODDS,
  COMBI_BOOST_TIERS,
  combiBoostMultiplierFor,
  computeCombiBoost,
  type CombiBoostConfigLive,
} from "./combi-boost.js";

test("custom config overrides defaults: 3-leg threshold + x1.10", () => {
  const config: CombiBoostConfigLive = {
    enabled: true,
    minOdds: 1.5,
    tiers: [
      { minLegs: 3, multiplier: 1.1, label: "x1.10" },
      { minLegs: 5, multiplier: 1.2, label: "x1.20" },
    ],
  };
  const s = computeCombiBoost(["1.80", "1.80", "1.80"], config);
  assert.equal(s.eligibleLegCount, 3);
  assert.equal(s.multiplier, 1.1);
  assert.equal(s.currentTier?.label, "x1.10");
  assert.equal(s.nextTier?.minLegs, 5);
  assert.equal(s.legsToNextTier, 2);
});

test("disabled config short-circuits to multiplier 1.0", () => {
  const config: CombiBoostConfigLive = {
    enabled: false,
    minOdds: 1.5,
    tiers: COMBI_BOOST_TIERS,
  };
  const s = computeCombiBoost(["2.00", "2.00", "2.00", "2.00"], config);
  assert.equal(s.multiplier, 1.0);
  assert.equal(s.currentTier, null);
  assert.equal(s.nextTier, null);
});

test("single leg never reaches a tier", () => {
  const s = computeCombiBoost(["2.50"]);
  assert.equal(s.eligibleLegCount, 1);
  assert.equal(s.multiplier, 1.0);
  assert.equal(s.currentTier, null);
  assert.equal(s.nextTier?.minLegs, 2);
  assert.equal(s.legsToNextTier, 1);
});

test("two legs >= 1.50 unlock the first tier", () => {
  const s = computeCombiBoost(["1.50", "1.80"]);
  assert.equal(s.eligibleLegCount, 2);
  assert.equal(s.multiplier, 1.03);
  assert.equal(s.currentTier?.label, "x1.03");
  assert.equal(s.nextTier?.minLegs, 4);
  assert.equal(s.legsToNextTier, 2);
});

test("legs strictly below 1.50 don't count", () => {
  const s = computeCombiBoost(["1.49", "1.49", "1.49"]);
  assert.equal(s.eligibleLegCount, 0);
  assert.equal(s.multiplier, 1.0);
  assert.equal(s.currentTier, null);
});

test("mix: only legs >= 1.50 count toward the threshold", () => {
  // Five legs in slip but only 3 are eligible — still on x1.03 tier
  // (4 needed for x1.05).
  const s = computeCombiBoost(["1.40", "1.50", "2.00", "1.45", "3.00"]);
  assert.equal(s.eligibleLegCount, 3);
  assert.equal(s.multiplier, 1.03);
  assert.equal(s.legsToNextTier, 1);
});

test("eight eligible legs reach the top tier", () => {
  const odds = Array.from({ length: 8 }, () => "1.80");
  const s = computeCombiBoost(odds);
  assert.equal(s.eligibleLegCount, 8);
  assert.equal(s.multiplier, 1.12);
  assert.equal(s.currentTier?.label, "x1.12");
  assert.equal(s.nextTier, null);
  assert.equal(s.legsToNextTier, 0);
});

test("more than 8 eligible legs stays at the top tier", () => {
  const s = computeCombiBoost(Array.from({ length: 12 }, () => "2.00"));
  assert.equal(s.multiplier, 1.12);
  assert.equal(s.nextTier, null);
});

test("non-finite leg odds are ignored, not faulted", () => {
  const s = computeCombiBoost(["abc", "1.80", "1.80", "NaN"]);
  // Only the two parseable, eligible legs count.
  assert.equal(s.eligibleLegCount, 2);
  assert.equal(s.multiplier, 1.03);
});

test("convenience helper returns just the multiplier", () => {
  assert.equal(combiBoostMultiplierFor(["1.80", "1.80", "1.80", "1.80"]), 1.05);
  assert.equal(combiBoostMultiplierFor(["1.80"]), 1.0);
});

test("tier table is monotonically increasing", () => {
  for (let i = 1; i < COMBI_BOOST_TIERS.length; i++) {
    assert.ok(COMBI_BOOST_TIERS[i]!.minLegs > COMBI_BOOST_TIERS[i - 1]!.minLegs);
    assert.ok(COMBI_BOOST_TIERS[i]!.multiplier > COMBI_BOOST_TIERS[i - 1]!.multiplier);
  }
});

test("min-odds constant matches the boundary used by computeCombiBoost", () => {
  // Just above and just below the documented floor.
  assert.equal(
    computeCombiBoost([
      String(COMBI_BOOST_MIN_ODDS),
      String(COMBI_BOOST_MIN_ODDS),
    ]).eligibleLegCount,
    2,
  );
  assert.equal(
    computeCombiBoost([
      String(COMBI_BOOST_MIN_ODDS - 0.01),
      String(COMBI_BOOST_MIN_ODDS - 0.01),
    ]).eligibleLegCount,
    0,
  );
});
