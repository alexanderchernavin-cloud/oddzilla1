import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { priceTiple, priceTippot, parseProbability } from "./products.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "..", "..", "docs", "fixtures", "products.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  tiple: Array<{
    name: string;
    probabilities: string[];
    marginBp: number;
    offeredOdds: string;
    fairProbability: number;
  }>;
  tippot: Array<{
    name: string;
    probabilities: string[];
    marginBp: number;
    tiers: Array<{ k: number; pAtLeastK: string; multiplier: string }>;
  }>;
};

test("tiple golden fixture", () => {
  for (const tc of fixture.tiple) {
    const probs = tc.probabilities.map(parseProbability);
    const q = priceTiple(probs, tc.marginBp);
    assert.equal(q.offeredOdds, tc.offeredOdds, `${tc.name}: offeredOdds`);
    // fairProbability is a float; allow tiny ULP diff but expect ~12 dp
    // agreement. The fixture stores it to 6-ish dp.
    const diff = Math.abs(q.fairProbability - tc.fairProbability);
    assert.ok(diff < 1e-9, `${tc.name}: fairProbability diff ${diff}`);
  }
});

test("tippot golden fixture", () => {
  for (const tc of fixture.tippot) {
    const probs = tc.probabilities.map(parseProbability);
    const q = priceTippot(probs, tc.marginBp);
    assert.equal(q.tiers.length, tc.tiers.length, `${tc.name}: tier count`);
    for (let i = 0; i < tc.tiers.length; i++) {
      const got = q.tiers[i]!;
      const want = tc.tiers[i]!;
      assert.equal(got.k, want.k, `${tc.name}: tier[${i}].k`);
      assert.equal(got.pAtLeastK, want.pAtLeastK, `${tc.name}: tier[${i}].pAtLeastK`);
      assert.equal(got.multiplier, want.multiplier, `${tc.name}: tier[${i}].multiplier`);
    }
  }
});

test("tippot multiplier is strictly increasing in k", () => {
  // Property: M_j > M_{j-1} for j ≥ 2 — invariant of the tier
  // construction. Catches algorithm regressions even if fixture rots.
  const cases: Array<{ probs: number[]; bp: number }> = [
    { probs: [0.1, 0.2, 0.3, 0.4, 0.5], bp: 1500 },
    { probs: [0.5, 0.5, 0.5], bp: 1500 },
    { probs: [0.05, 0.1, 0.15, 0.2, 0.25, 0.3], bp: 0 },
    { probs: [0.9, 0.9, 0.9, 0.9], bp: 1500 },
  ];
  for (const c of cases) {
    const q = priceTippot(c.probs, c.bp);
    let prev = -Infinity;
    for (const tier of q.tiers) {
      const m = Number(tier.multiplier);
      assert.ok(m > prev, `multiplier should strictly increase: prev=${prev} m=${m}`);
      prev = m;
    }
  }
});

test("tippot expected payout matches 1/(1+margin) up to floor truncation", () => {
  // Property: E[payout]/stake = 1/(1+m) exactly in real math. Floor
  // truncation makes the actual sum a hair lower. We require the gap
  // to be ≤ N × 10^-decimals (1 ULP per tier) — a tight bound that
  // catches any algorithmic drift.
  const decimals = 4;
  const ulp = Math.pow(10, -decimals);
  const cases: Array<{ probs: number[]; bp: number }> = [
    { probs: [0.5, 0.5, 0.5], bp: 1500 },
    { probs: [0.2, 0.2, 0.2, 0.2, 0.2], bp: 0 },
    { probs: [0.3, 0.4, 0.5, 0.6], bp: 1500 },
  ];
  for (const c of cases) {
    const q = priceTippot(c.probs, c.bp);
    const n = c.probs.length;
    // Reproduce the PMF inline to compute E[payout].
    let pmf = new Array(n + 1).fill(0);
    pmf[0] = 1;
    for (const p of c.probs) {
      const next = new Array(n + 1).fill(0);
      for (let k = 0; k <= pmf.length - 1; k++) {
        const stayLose = pmf[k] * (1 - p);
        const gainWin = k > 0 ? pmf[k - 1] * p : 0;
        next[k] = stayLose + gainWin;
      }
      pmf = next;
    }
    let expected = 0;
    for (let j = 1; j <= n; j++) {
      expected += pmf[j] * Number(q.tiers[j - 1]!.multiplier);
    }
    const target = 1 / (1 + c.bp / 10000);
    assert.ok(
      expected <= target + 1e-9,
      `payout exceeds margin target: expected=${expected} target=${target}`,
    );
    assert.ok(
      expected >= target - n * ulp,
      `payout under-pays bettor too much: expected=${expected} target=${target} (allowed slack ${n * ulp})`,
    );
  }
});

test("rejects out-of-range probabilities", () => {
  assert.throws(() => priceTiple([0.5, 1.0], 1500), /\(0,1\)/);
  assert.throws(() => priceTiple([0.5, 0], 1500), /\(0,1\)/);
  assert.throws(() => priceTippot([0.5, -0.1], 1500), /\(0,1\)/);
});

test("rejects too few legs", () => {
  assert.throws(() => priceTiple([0.5], 1500), /≥ 2 legs/);
  assert.throws(() => priceTippot([0.5], 1500), /≥ 2 legs/);
});

test("rejects out-of-range margin", () => {
  assert.throws(() => priceTiple([0.5, 0.5], -1), /margin_bp/);
  assert.throws(() => priceTiple([0.5, 0.5], 200001), /margin_bp/);
});
