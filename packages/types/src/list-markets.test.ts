import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  LADDER_HANDICAP_SHAPES,
  LADDER_PROVIDER_MARKET_IDS,
  LADDER_TOTAL_SHAPES,
  handicapLineForSide,
  isFullMatchLadderMarket,
  ladderShapeByProviderMarketId,
  pickMainLine,
  type LadderRung,
} from "./list-markets.js";

function rung(line: string, first: number | null, second: number | null): LadderRung<string> {
  return { line, firstPrice: first, secondPrice: second, payload: line };
}

// The ladder Fonbet was quoting for Getafe vs Celta on 2026-09-07,
// verbatim from /catalog/matches/1184067. A trader would call this line
// 0 — the only rung anywhere near even.
test("picks the balanced rung of a real Fonbet handicap ladder", () => {
  const picked = pickMainLine([
    rung("-1.5", 5.7, 1.09),
    rung("-1", 4.6, 1.14),
    rung("0", 1.7, 2.17),
    rung("1", 1.07, 6.4),
    rung("1.5", 1.05, 7.4),
  ]);
  assert.equal(picked?.line, "0");
});

// Same match's total ladder. 1.5 (1.70 / 2.15) beats 2 (2.20 / 1.62):
// on implied probability the gaps are 0.123 and 0.163.
test("picks the balanced rung of a real Fonbet total ladder", () => {
  const picked = pickMainLine([
    rung("0.5", 1.14, 4.7),
    rung("1", 1.23, 3.7),
    rung("1.5", 1.7, 2.15),
    rung("2", 2.2, 1.62),
    rung("2.5", 2.8, 1.38),
    rung("3", 4.7, 1.14),
    rung("3.5", 5.4, 1.1),
  ]);
  assert.equal(picked?.line, "1.5");
});

// The score is normalised by the pair's own level, so it measures
// balance rather than distance. Two rungs at the same price RATIO are
// equally balanced whatever their level, and must tie — leaving the
// line-nearest-zero tiebreak to decide. Without the normalisation the
// deeper rung would win on its own, which is how a raw probability gap
// would hand the column to a line out in the tail.
test("balance is scale-invariant: equal ratios tie", () => {
  const a = pickMainLine([rung("-3.5", 4.0, 4.4), rung("0", 2.0, 2.2)]);
  assert.equal(a?.line, "0");
  const b = pickMainLine([rung("0", 2.0, 2.2), rung("-3.5", 4.0, 4.4)]);
  assert.equal(b?.line, "0");
});

// A level pair beats a lopsided one at any price level.
test("a level rung beats a lopsided one", () => {
  assert.equal(pickMainLine([rung("0", 1.9, 1.9), rung("-2.5", 1.2, 4.5)])?.line, "0");
  assert.equal(pickMainLine([rung("-2.5", 1.2, 4.5), rung("0", 1.9, 1.9)])?.line, "0");
});

test("skips a rung that is only half priced", () => {
  const picked = pickMainLine([
    rung("0", 1.95, null),
    rung("-1.5", 2.6, 1.5),
  ]);
  assert.equal(picked?.line, "-1.5");
});

// A price at or below 1.00 returns no profit and is not offered
// anywhere else in the product; it must not be able to win a column
// by being "balanced" against another unbettable price either.
test("skips a rung whose price is not bettable", () => {
  const picked = pickMainLine([rung("0", 1.0, 1.0), rung("2.5", 1.7, 2.2)]);
  assert.equal(picked?.line, "2.5");
});

test("returns null when no rung qualifies", () => {
  assert.equal(pickMainLine([rung("0", null, null)]), null);
  assert.equal(pickMainLine([]), null);
});

// Determinism matters more than which way a tie breaks: an unstable
// pick would flicker the column between rungs on every poll.
test("breaks an exact tie toward the line nearest zero, then by string", () => {
  const a = pickMainLine([rung("-2.5", 1.9, 1.9), rung("0", 1.9, 1.9)]);
  assert.equal(a?.line, "0");
  const b = pickMainLine([rung("0", 1.9, 1.9), rung("-2.5", 1.9, 1.9)]);
  assert.equal(b?.line, "0");
});

// The filter that keeps sub-events and per-map copies out of a card.
test("only a lone line specifier qualifies as a full-match rung", () => {
  const fonbetHandicap = ladderShapeByProviderMarketId(1_000_304)!.shape;
  const oddinHandicap = ladderShapeByProviderMarketId(2)!.shape;
  assert.equal(isFullMatchLadderMarket({ handicap: "-1" }, fonbetHandicap), true);
  assert.equal(isFullMatchLadderMarket({ handicap: "-1.5" }, oddinHandicap), true);
  // Fonbet corners handicap.
  assert.equal(
    isFullMatchLadderMarket({ variant: "fb:400100", handicap: "0" }, fonbetHandicap),
    false,
  );
  // Oddin per-map round handicap.
  assert.equal(
    isFullMatchLadderMarket({ map: "1", handicap: "9.5" }, oddinHandicap),
    false,
  );
  assert.equal(isFullMatchLadderMarket({}, oddinHandicap), false);
  assert.equal(isFullMatchLadderMarket(null, oddinHandicap), false);
  // Wrong key for this shape (a total's threshold on a handicap shape).
  assert.equal(isFullMatchLadderMarket({ threshold: "2.5" }, fonbetHandicap), false);
});

// The two ids a card can resolve a handicap to key their outcomes
// differently — Oddin `1` / `2`, Fonbet `h1` / `h2` — which is why the
// loader buckets rungs per provider before picking a line.
test("each feed keeps its own outcome ids", () => {
  assert.deepEqual(ladderShapeByProviderMarketId(2)?.shape.outcomeIds, ["1", "2"]);
  assert.deepEqual(ladderShapeByProviderMarketId(1_000_304)?.shape.outcomeIds, [
    "h1",
    "h2",
  ]);
  // Over first in both, and Oddin's pair is NOT in numeric order.
  assert.deepEqual(ladderShapeByProviderMarketId(3)?.shape.outcomeIds, ["5", "4"]);
  assert.deepEqual(ladderShapeByProviderMarketId(1_000_305)?.shape.outcomeIds, [
    "over",
    "under",
  ]);
});

test("provider market ids resolve back to their kind", () => {
  assert.equal(ladderShapeByProviderMarketId(2)?.kind, "handicap");
  assert.equal(ladderShapeByProviderMarketId(1_000_304)?.kind, "handicap");
  assert.equal(ladderShapeByProviderMarketId(3)?.kind, "total");
  assert.equal(ladderShapeByProviderMarketId(1_000_305)?.kind, "total");
  // Oddin match ROUND handicap / match total ROUNDS are deliberately
  // not list shapes — see the comments on the tables.
  assert.equal(ladderShapeByProviderMarketId(136), null);
  assert.equal(ladderShapeByProviderMarketId(156), null);
  assert.equal(ladderShapeByProviderMarketId(1), null);
});

test("the id list covers both tables and holds no duplicates", () => {
  const expected = [...LADDER_HANDICAP_SHAPES, ...LADDER_TOTAL_SHAPES].map(
    (s) => s.providerMarketId,
  );
  assert.deepEqual([...LADDER_PROVIDER_MARKET_IDS].sort(), [...expected].sort());
  assert.equal(new Set(LADDER_PROVIDER_MARKET_IDS).size, expected.length);
});

// The sign is the part that prints a whole column's line wrongly when
// it drifts — a home -0.5 showed as "-0.5" on the away side for every
// Fonbet handicap until 2026-09-07.
test("a handicap is negated for the away side and always signed", () => {
  assert.equal(handicapLineForSide("-1.5", false), "-1.5");
  assert.equal(handicapLineForSide("-1.5", true), "+1.5");
  assert.equal(handicapLineForSide("2", false), "+2");
  assert.equal(handicapLineForSide("2", true), "-2");
  // -0 must not print as "-0".
  assert.equal(handicapLineForSide("0", false), "0");
  assert.equal(handicapLineForSide("0", true), "0");
  assert.equal(handicapLineForSide(null, false), "");
  // Unparseable lines pass through rather than becoming "NaN".
  assert.equal(handicapLineForSide("abc", true), "abc");
});
