// Cashout algorithm unit tests. Mirror the Excel scenarios from
// /Cashout/Cashout Algorithm_051218.xlsx and the doc examples.
//
// Run with: tsx --test src/modules/cashout/algorithm.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { compute, lookupLadder } from "./algorithm.js";
import type { CashoutLadderStep } from "@oddzilla/types";

const baseConfig = {
  enabled: true,
  prematchFullPaybackSeconds: 0,
  deductionLadder: null,
  minOfferMicro: 0n,
  minValueChangeBp: 0,
};

describe("Simple Cashout (chapter 2.1.1)", () => {
  it("Excel Sheet1: stake 100, odds 60, prob 0.01 → cashout 60", () => {
    const r = compute({
      betType: "single",
      stakeMicro: 100_000_000n,
      potentialPayoutMicro: 6_000_000_000n,
      placedAtMs: 0,
      matchEarliestKickoffMs: null,
      legs: [
        {
          oddsAtPlacement: "60",
          probabilityCurrent: 0.01,
          oddsCurrent: "60",
          active: true,
          result: null,
          voidFactor: null,
        },
      ],
      config: baseConfig,
      nowMs: 60_000,
    });
    assert.equal(r.available, true);
    assert.equal(r.offerMicro, 60_000_000n);
  });

  it("EXAMPLE 1: stake 100, odds 1.9, prob 0.5 → 95; prob 0.8 → 152", () => {
    const at50 = compute({
      betType: "single",
      stakeMicro: 100_000_000n,
      potentialPayoutMicro: 190_000_000n,
      placedAtMs: 0,
      matchEarliestKickoffMs: null,
      legs: [
        {
          oddsAtPlacement: "1.9",
          probabilityCurrent: 0.5,
          oddsCurrent: "1.9",
          active: true,
          result: null,
          voidFactor: null,
        },
      ],
      config: baseConfig,
      nowMs: 0,
    });
    assert.equal(at50.offerMicro, 95_000_000n);

    const at80 = compute({
      betType: "single",
      stakeMicro: 100_000_000n,
      potentialPayoutMicro: 190_000_000n,
      placedAtMs: 0,
      matchEarliestKickoffMs: null,
      legs: [
        {
          oddsAtPlacement: "1.9",
          probabilityCurrent: 0.8,
          oddsCurrent: "1.5",
          active: true,
          result: null,
          voidFactor: null,
        },
      ],
      config: baseConfig,
      nowMs: 0,
    });
    assert.equal(at80.offerMicro, 152_000_000n);
  });

  it("offer is capped at potential payout", () => {
    const r = compute({
      betType: "single",
      stakeMicro: 100_000_000n,
      potentialPayoutMicro: 150_000_000n,
      placedAtMs: 0,
      matchEarliestKickoffMs: null,
      legs: [
        {
          oddsAtPlacement: "1.5",
          probabilityCurrent: 0.999,
          oddsCurrent: "1.001",
          active: true,
          result: null,
          voidFactor: null,
        },
      ],
      config: baseConfig,
      nowMs: 0,
    });
    assert.ok(r.offerMicro <= 150_000_000n);
  });
});

describe("Combo cashout", () => {
  it("won leg drops out of probability product", () => {
    const r = compute({
      betType: "combo",
      stakeMicro: 100_000_000n,
      potentialPayoutMicro: 400_000_000n,
      placedAtMs: 0,
      matchEarliestKickoffMs: null,
      legs: [
        {
          oddsAtPlacement: "2",
          probabilityCurrent: null,
          oddsCurrent: null,
          active: false,
          result: "won",
          voidFactor: null,
        },
        {
          oddsAtPlacement: "2",
          probabilityCurrent: 0.5,
          oddsCurrent: "2",
          active: true,
          result: null,
          voidFactor: null,
        },
      ],
      config: baseConfig,
      nowMs: 0,
    });
    assert.equal(r.available, true);
    assert.equal(r.offerMicro, 200_000_000n);
  });

  it("lost leg collapses offer to 0", () => {
    const r = compute({
      betType: "combo",
      stakeMicro: 100_000_000n,
      potentialPayoutMicro: 400_000_000n,
      placedAtMs: 0,
      matchEarliestKickoffMs: null,
      legs: [
        {
          oddsAtPlacement: "2",
          probabilityCurrent: null,
          oddsCurrent: null,
          active: false,
          result: "lost",
          voidFactor: null,
        },
        {
          oddsAtPlacement: "2",
          probabilityCurrent: 0.5,
          oddsCurrent: "2",
          active: true,
          result: null,
          voidFactor: null,
        },
      ],
      config: baseConfig,
      nowMs: 0,
    });
    assert.equal(r.available, false);
    assert.equal(r.reason, "leg_lost");
  });

  it("inactive leg blocks cashout", () => {
    const r = compute({
      betType: "combo",
      stakeMicro: 100_000_000n,
      potentialPayoutMicro: 400_000_000n,
      placedAtMs: 0,
      matchEarliestKickoffMs: null,
      legs: [
        {
          oddsAtPlacement: "2",
          probabilityCurrent: 0.5,
          oddsCurrent: "2",
          active: false,
          result: null,
          voidFactor: null,
        },
      ],
      config: baseConfig,
      nowMs: 0,
    });
    assert.equal(r.available, false);
    assert.equal(r.reason, "leg_inactive");
  });

  it("voided leg drops out (refund-style)", () => {
    const r = compute({
      betType: "combo",
      stakeMicro: 100_000_000n,
      potentialPayoutMicro: 400_000_000n,
      placedAtMs: 0,
      matchEarliestKickoffMs: null,
      legs: [
        {
          oddsAtPlacement: "2",
          probabilityCurrent: null,
          oddsCurrent: null,
          active: false,
          result: "void",
          voidFactor: "1",
        },
        {
          oddsAtPlacement: "1.5",
          probabilityCurrent: 0.7,
          oddsCurrent: "1.5",
          active: true,
          result: null,
          voidFactor: null,
        },
      ],
      config: baseConfig,
      nowMs: 0,
    });
    assert.equal(r.available, true);
    assert.equal(r.offerMicro, 105_000_000n);
  });
});

describe("Prematch full-stake window", () => {
  it("returns full stake within window when match has not started", () => {
    const r = compute({
      betType: "single",
      stakeMicro: 100_000_000n,
      potentialPayoutMicro: 200_000_000n,
      placedAtMs: 1000,
      matchEarliestKickoffMs: 60 * 60 * 1000,
      legs: [
        {
          oddsAtPlacement: "2",
          probabilityCurrent: 0.5,
          oddsCurrent: "2",
          active: true,
          result: null,
          voidFactor: null,
        },
      ],
      config: { ...baseConfig, prematchFullPaybackSeconds: 60 },
      nowMs: 30 * 1000,
    });
    assert.equal(r.available, true);
    assert.equal(r.fullPayback, true);
    assert.equal(r.offerMicro, 100_000_000n);
  });

  it("falls back to probabilistic offer once window expires", () => {
    const r = compute({
      betType: "single",
      stakeMicro: 100_000_000n,
      potentialPayoutMicro: 200_000_000n,
      placedAtMs: 0,
      matchEarliestKickoffMs: 60 * 60 * 1000,
      legs: [
        {
          oddsAtPlacement: "2",
          probabilityCurrent: 0.4,
          oddsCurrent: "2",
          active: true,
          result: null,
          voidFactor: null,
        },
      ],
      config: { ...baseConfig, prematchFullPaybackSeconds: 60 },
      nowMs: 90 * 1000,
    });
    assert.equal(r.available, true);
    assert.equal(r.fullPayback, false);
    assert.equal(r.offerMicro, 80_000_000n);
  });

  it("does NOT trigger when match is already in play", () => {
    const r = compute({
      betType: "single",
      stakeMicro: 100_000_000n,
      potentialPayoutMicro: 200_000_000n,
      placedAtMs: 0,
      matchEarliestKickoffMs: -1000,
      legs: [
        {
          oddsAtPlacement: "2",
          probabilityCurrent: 0.4,
          oddsCurrent: "2",
          active: true,
          result: null,
          voidFactor: null,
        },
      ],
      config: { ...baseConfig, prematchFullPaybackSeconds: 60 },
      nowMs: 30 * 1000,
    });
    assert.equal(r.fullPayback, false);
    assert.equal(r.offerMicro, 80_000_000n);
  });
});

describe("Deduction ladder (chapter 2.1.2)", () => {
  const ladder: CashoutLadderStep[] = [
    { factor: 0.05, deduction: 1.05 },
    { factor: 0.5, deduction: 1.025 },
    { factor: 1, deduction: 1.005 },
    { factor: 5, deduction: 1.075 },
    { factor: 100, deduction: 1.5 },
  ];

  it("interpolates between rows", () => {
    const got = lookupLadder(ladder, 0.275);
    assert.ok(Math.abs(got - 1.0375) < 0.0001);
  });

  it("clamps to ends of ladder", () => {
    assert.equal(lookupLadder(ladder, 0.001), 1.05);
    assert.equal(lookupLadder(ladder, 9999), 1.5);
  });

  it("applies deduction to fair offer", () => {
    const r = compute({
      betType: "single",
      stakeMicro: 100_000_000n,
      potentialPayoutMicro: 6_000_000_000n,
      placedAtMs: 0,
      matchEarliestKickoffMs: null,
      legs: [
        {
          oddsAtPlacement: "60",
          probabilityCurrent: 0.01,
          oddsCurrent: "60",
          active: true,
          result: null,
          voidFactor: null,
        },
      ],
      config: { ...baseConfig, deductionLadder: ladder },
      nowMs: 0,
    });
    assert.equal(r.available, true);
    // ratio=0.6 → deduction ≈ 1.021 → offer ≈ 58.766 USDT
    assert.ok(Number(r.offerMicro) > 58_700_000, `offer ${r.offerMicro}`);
    assert.ok(Number(r.offerMicro) < 58_800_000, `offer ${r.offerMicro}`);
  });
});

describe("Floor + minimum offer", () => {
  it("blocks when offer below configured minimum", () => {
    const r = compute({
      betType: "single",
      stakeMicro: 100_000_000n,
      potentialPayoutMicro: 200_000_000n,
      placedAtMs: 0,
      matchEarliestKickoffMs: null,
      legs: [
        {
          oddsAtPlacement: "2",
          probabilityCurrent: 0.001,
          oddsCurrent: "2",
          active: true,
          result: null,
          voidFactor: null,
        },
      ],
      config: { ...baseConfig, minOfferMicro: 1_000_000n },
      nowMs: 0,
    });
    assert.equal(r.available, false);
    assert.equal(r.reason, "below_minimum");
  });
});

describe("Probability fallback", () => {
  it("uses 1/oddsCurrent when probabilityCurrent is null", () => {
    const r = compute({
      betType: "single",
      stakeMicro: 100_000_000n,
      potentialPayoutMicro: 200_000_000n,
      placedAtMs: 0,
      matchEarliestKickoffMs: null,
      legs: [
        {
          oddsAtPlacement: "2",
          probabilityCurrent: null,
          oddsCurrent: "1.6",
          active: true,
          result: null,
          voidFactor: null,
        },
      ],
      config: baseConfig,
      nowMs: 0,
    });
    assert.equal(r.available, true);
    assert.equal(r.offerMicro, 125_000_000n);
  });

  it("flags leg_no_probability when both inputs missing", () => {
    const r = compute({
      betType: "single",
      stakeMicro: 100_000_000n,
      potentialPayoutMicro: 200_000_000n,
      placedAtMs: 0,
      matchEarliestKickoffMs: null,
      legs: [
        {
          oddsAtPlacement: "2",
          probabilityCurrent: null,
          oddsCurrent: null,
          active: true,
          result: null,
          voidFactor: null,
        },
      ],
      config: baseConfig,
      nowMs: 0,
    });
    assert.equal(r.available, false);
    assert.equal(r.reason, "leg_no_probability");
  });
});
