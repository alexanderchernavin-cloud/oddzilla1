import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyFeedTabMembership,
  resolveGroupRows,
  type GroupableMarket,
} from "./market-groups.js";

// A football fixture as the catalog builds it: the base event, plus the
// same market types repeated on each Fonbet sub-event. Totals come as
// ladders — several markets of one type, one per threshold — which is the
// case a row has to admit whole.
function market(
  id: string,
  providerMarketId: number,
  variant: string,
  scopeId: string,
  scopeOrder: number,
): GroupableMarket {
  return { id, providerMarketId, variant, scope: { id: scopeId, order: scopeOrder } };
}

const MATCH_RESULT = market("m1", 1000120, "", "match", 0);
const MATCH_TOTAL_15 = market("m2", 1000305, "", "match", 0);
const MATCH_TOTAL_25 = market("m3", 1000305, "", "match", 0);
const HALF_RESULT = market("m4", 1000120, "fb:100201", "fb_100201", 10.1);
const CORNERS_RESULT = market("m5", 1000120, "fb:400100", "fb_400100", 10.4);
const CORNERS_TOTAL_85 = market("m6", 1000305, "fb:400100", "fb_400100", 10.4);
const CORNERS_TOTAL_95 = market("m7", 1000305, "fb:400100", "fb_400100", 10.4);
const MAP1_TOTAL = market("m8", 1000305, "", "map_1", 1);

const ALL = [
  MATCH_RESULT,
  MATCH_TOTAL_15,
  MATCH_TOTAL_25,
  HALF_RESULT,
  CORNERS_RESULT,
  CORNERS_TOTAL_85,
  CORNERS_TOTAL_95,
  MAP1_TOTAL,
];

const ids = (list: GroupableMarket[]) => list.map((m) => m.id);
const row = (providerMarketId: number, variant: string, displayOrder: number) => ({
  providerMarketId,
  variant,
  displayOrder,
});

describe("resolveGroupRows — feed tabs", () => {
  it("resolves a wildcard row inside its own tab", () => {
    // "Total" on the Corners tab means the corners total. Reading it as
    // "any copy" would drag the match total onto a corners heading.
    assert.deepEqual(
      ids(resolveGroupRows(ALL, "fb_400100", [row(1000305, "", 0)], false)),
      ["m6", "m7"],
    );
    assert.deepEqual(
      ids(resolveGroupRows(ALL, "match", [row(1000305, "", 0)], false)),
      ["m2", "m3"],
    );
  });

  it("admits the whole ladder, not one arbitrary line", () => {
    const out = resolveGroupRows(ALL, "match", [row(1000305, "fb:400100", 0)], false);
    assert.deepEqual(ids(out), ["m6", "m7"]);
  });

  it("imports a market from another sub-event, in the operator's order", () => {
    const out = resolveGroupRows(
      ALL,
      "match",
      [row(1000305, "fb:400100", 0), row(1000120, "", 1)],
      false,
    );
    assert.deepEqual(ids(out), ["m6", "m7", "m1"]);
  });

  it("skips a row this fixture carries no market for", () => {
    const out = resolveGroupRows(
      ALL,
      "match",
      [row(1000120, "", 0), row(999999, "", 1)],
      false,
    );
    assert.deepEqual(ids(out), ["m1"]);
  });

  it("renders a market once when two rows resolve to it", () => {
    const out = resolveGroupRows(
      ALL,
      "fb_400100",
      [row(1000305, "", 0), row(1000305, "fb:400100", 1)],
      false,
    );
    assert.deepEqual(ids(out), ["m6", "m7"]);
  });
});

describe("resolveGroupRows — curated tabs", () => {
  it("features one representative for a legacy wildcard row", () => {
    // Pre-0109 rows could not name a sub-event; they still mean "any copy,
    // show one", preferring the match-scope one.
    const out = resolveGroupRows(ALL, "top", [row(1000305, "", 0)], true);
    assert.deepEqual(ids(out), ["m2"]);
  });

  it("falls back to the lowest-order scope when there is no match copy", () => {
    const out = resolveGroupRows(
      [MAP1_TOTAL, CORNERS_TOTAL_85],
      "top",
      [row(1000305, "", 0)],
      true,
    );
    assert.deepEqual(ids(out), ["m8"]);
  });

  it("admits the ladder for a row that names the sub-event", () => {
    const out = resolveGroupRows(ALL, "top", [row(1000305, "fb:400100", 0)], true);
    assert.deepEqual(ids(out), ["m6", "m7"]);
  });
});

describe("applyFeedTabMembership", () => {
  const own = [MATCH_RESULT, MATCH_TOTAL_25, MATCH_TOTAL_15];

  it("auto keeps the unlisted feed markets, after the list", () => {
    const out = applyFeedTabMembership(own, [MATCH_TOTAL_15], "auto");
    assert.deepEqual(ids(out), ["m2", "m1", "m3"]);
  });

  it("auto sorts the remainder by market id, the pre-config default", () => {
    const out = applyFeedTabMembership(own, [], "auto");
    assert.deepEqual(ids(out), ["m1", "m3", "m2"]);
  });

  it("manual renders exactly the list", () => {
    const out = applyFeedTabMembership(own, [MATCH_TOTAL_15], "manual");
    assert.deepEqual(ids(out), ["m2"]);
  });

  it("auto never drops a market the operator's list does not mention", () => {
    // The backoffice pool is built from the current offer, so a market
    // kind that was not live when the order was saved is not in the list.
    // Under 'auto' it still reaches bettors — that is the whole point of
    // the default.
    const late = market("m9", 1000600, "", "match", 0);
    const out = applyFeedTabMembership([...own, late], [MATCH_RESULT], "auto");
    assert.ok(ids(out).includes("m9"));
  });

  it("does not duplicate an imported market that the feed also puts here", () => {
    const out = applyFeedTabMembership(own, [MATCH_RESULT, MATCH_TOTAL_15], "auto");
    assert.deepEqual(ids(out), ["m1", "m2", "m3"]);
  });
});
