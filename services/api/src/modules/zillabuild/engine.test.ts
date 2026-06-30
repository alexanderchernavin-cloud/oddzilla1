// Unit tests for the pure ZillaBuild card-assembly helpers. The
// OBB/DB-backed `getZillaBuildForMatch` isn't covered here (it needs a live
// gRPC + Postgres); these lock down the deterministic combinatorics.
//
// Run with: tsx --test src/modules/zillabuild/engine.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  legSetKey,
  randInt,
  shuffled,
  pickCandidateLegs,
  isCleanLabel,
  conflictKey,
  type EligibleMarket,
  type StoredLeg,
} from "./engine.js";

function mkMarket(id: string, outcomes: string[]): EligibleMarket {
  return {
    id,
    providerMarketId: Number(id),
    specifiers: {},
    variant: "",
    mapNumber: 1,
    marketLabel: "",
    outcomes: outcomes.map((o) => ({ outcomeId: o, odds: "2.00" })),
  };
}

function mk(
  id: string,
  providerMarketId: number,
  specifiers: Record<string, string>,
  outcomes: string[],
): EligibleMarket {
  return {
    id,
    providerMarketId,
    specifiers,
    variant: specifiers.variant ?? "",
    mapNumber: 1,
    marketLabel: "x",
    outcomes: outcomes.map((o) => ({ outcomeId: o, odds: "2.00" })),
  };
}

describe("legSetKey", () => {
  it("is order-independent across legs", () => {
    const a: StoredLeg[] = [
      { marketId: "1", outcomeId: "x" },
      { marketId: "2", outcomeId: "y" },
    ];
    const b: StoredLeg[] = [
      { marketId: "2", outcomeId: "y" },
      { marketId: "1", outcomeId: "x" },
    ];
    assert.equal(legSetKey(a), legSetKey(b));
  });

  it("distinguishes a different outcome on the same market", () => {
    assert.notEqual(
      legSetKey([{ marketId: "1", outcomeId: "x" }]),
      legSetKey([{ marketId: "1", outcomeId: "y" }]),
    );
  });
});

describe("randInt", () => {
  it("returns lo when the range is degenerate", () => {
    assert.equal(randInt(3, 3, () => 0.99), 3);
    assert.equal(randInt(5, 2, () => 0.99), 5);
  });

  it("spans the inclusive range at the rng extremes", () => {
    assert.equal(randInt(2, 4, () => 0), 2);
    assert.equal(randInt(2, 4, () => 0.999), 4);
  });
});

describe("shuffled", () => {
  it("returns a permutation and does not mutate the input", () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffled(input, () => 0.42);
    assert.deepEqual(input, [1, 2, 3, 4, 5]); // input untouched
    assert.deepEqual(
      [...out].sort((a, b) => a - b),
      [1, 2, 3, 4, 5],
    ); // same multiset
    assert.equal(out.length, 5);
  });
});

describe("isCleanLabel", () => {
  it("accepts fully-resolved labels", () => {
    for (const ok of [
      "Map 1 winner",
      "Ninjas in Pyjamas",
      "Under",
      "xiELO Total kills 14.5 - map 1",
      "Pistol Round 1 winner - map 1",
    ]) {
      assert.equal(isCleanLabel(ok), true, ok);
    }
  });

  it("rejects the no-template fallback, unresolved URNs, and leftover placeholders", () => {
    for (const bad of [
      "Market #107",
      "od:player:18786 Total kills 15.5 - map 1",
      "OD:PLAYER:18786 TOTAL KILLS",
      "od:competitor:42",
      "Total kills {threshold} - map {map}",
      undefined,
    ]) {
      assert.equal(isCleanLabel(bad), false, String(bad));
    }
  });
});

describe("conflictKey", () => {
  it("collapses variant/line differences of the same market", () => {
    // Map-1-winner two-way vs three-way — same pmi, no subject → same family.
    assert.equal(
      conflictKey({ providerMarketId: 6, specifiers: { map: "1", variant: "way:two", way: "two" } }),
      conflictKey({ providerMarketId: 6, specifiers: { map: "1", variant: "way:three", way: "three" } }),
    );
  });

  it("keeps different players' props (same pmi, different subject) distinct", () => {
    assert.notEqual(
      conflictKey({ providerMarketId: 169, specifiers: { entity: "od:player:1", threshold: "14.5" } }),
      conflictKey({ providerMarketId: 169, specifiers: { entity: "od:player:2", threshold: "14.5" } }),
    );
  });
});

describe("pickCandidateLegs — same-family exclusion", () => {
  // Two variants of map-1-winner (same family) + two distinct markets.
  const markets = [
    mk("a", 6, { map: "1", variant: "way:three", way: "three" }, ["3"]),
    mk("b", 6, { map: "1", variant: "way:two", way: "two" }, ["1"]),
    mk("c", 28, { map: "1" }, ["4"]),
    mk("d", 169, { map: "1", entity: "od:player:1" }, ["4"]),
  ];

  it("never puts two legs from the same market family on one card", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
      const legs = pickCandidateLegs(markets, { minLegs: 2, maxLegs: 4 }, () => r);
      assert.ok(legs, `expected legs at rng=${r}`);
      const fromWinnerFamily = legs!.filter(
        (l) => l.marketId === "a" || l.marketId === "b",
      ).length;
      assert.ok(fromWinnerFamily <= 1, `picked ${fromWinnerFamily} winner-variants at rng=${r}`);
      const keys = new Set(legs!.map((l) => l.marketId));
      assert.equal(keys.size, legs!.length); // still distinct markets
    }
  });
});

describe("pickCandidateLegs", () => {
  const markets = [
    mkMarket("1", ["a"]),
    mkMarket("2", ["b"]),
    mkMarket("3", ["c"]),
    mkMarket("4", ["d"]),
  ];

  it("returns null when there are fewer eligible markets than minLegs", () => {
    assert.equal(
      pickCandidateLegs([mkMarket("1", ["a"])], { minLegs: 2, maxLegs: 4 }),
      null,
    );
  });

  it("picks between minLegs and maxLegs distinct markets", () => {
    for (const r of [0, 0.3, 0.6, 0.99]) {
      const legs = pickCandidateLegs(markets, { minLegs: 2, maxLegs: 4 }, () => r);
      assert.ok(legs, `expected legs for rng=${r}`);
      assert.ok(legs!.length >= 2 && legs!.length <= 4);
      const marketIds = new Set(legs!.map((l) => l.marketId));
      assert.equal(marketIds.size, legs!.length); // one leg per distinct market
    }
  });

  it("caps the leg count at the number of available markets", () => {
    const legs = pickCandidateLegs(markets.slice(0, 2), { minLegs: 2, maxLegs: 4 }, () => 0.99);
    assert.ok(legs);
    assert.equal(legs!.length, 2);
  });

  it("only emits outcomes that belong to the chosen market", () => {
    const legs = pickCandidateLegs(markets, { minLegs: 4, maxLegs: 4 }, () => 0)!;
    assert.equal(legs.length, 4);
    for (const leg of legs) {
      const m = markets.find((x) => x.id === leg.marketId)!;
      assert.ok(m.outcomes.some((o) => o.outcomeId === leg.outcomeId));
    }
  });
});
