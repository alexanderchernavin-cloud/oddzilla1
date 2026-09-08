import { test } from "node:test";
import assert from "node:assert/strict";

import { isTeamShapedMarket, TEAM_SHAPED_PROVIDER_MARKET_IDS } from "./boosted-odds.js";
import { boostMarketKey, bookKey } from "./netwinstable.js";

const HOME_AWAY = ["1", "2"];

test("Oddin team-shaped markets are match winner and map winner only", () => {
  assert.equal(isTeamShapedMarket(1, HOME_AWAY), true); // match winner
  assert.equal(isTeamShapedMarket(4, HOME_AWAY), true); // map winner
  // Decided on the id alone for Oddin, whose ids are market TYPES — so
  // still true with no outcomes in hand.
  assert.equal(isTeamShapedMarket(1, []), true);
  // Symmetric / line-shaped: no single outcome "is" a team. These carry
  // "1" / "2" too, which is exactly why the Oddin branch is an id
  // allowlist rather than an outcome-shape test.
  for (const pmid of [2, 3, 7, 10, 11, 6]) {
    assert.equal(isTeamShapedMarket(pmid, HOME_AWAY), false, `pmid ${pmid}`);
  }
  assert.deepEqual([...TEAM_SHAPED_PROVIDER_MARKET_IDS], [1, 4]);
});

test("a Fonbet winner table is team-shaped, its sub-event copies are not", () => {
  // The operator's 2026-09-08 report: a team_only boost on Manchester
  // United did nothing. Its winner markets are these two (measured on
  // production), and neither is Oddin's 1, so an id-only predicate
  // matched nothing.
  assert.equal(isTeamShapedMarket(1_000_120, ["1", "2", "3"]), true);
  assert.equal(isTeamShapedMarket(1_024_598, ["1", "2"]), true);

  // Fonbet reuses one table across every sub-event, so "2nd half: Match
  // result" is ALSO 1000120 — told apart only by keeping its raw factor
  // ids. A team boost must not leak onto the second half.
  assert.equal(
    isTeamShapedMarket(1_000_120, ["921", "922", "923", "924", "925", "1571"]),
    false,
  );
  // The split-off double chance of the full match, likewise.
  assert.equal(isTeamShapedMarket(1_900_120, ["924", "925", "1571"]), false);

  // Both sides are required: the claim is that "1" IS home and "2" IS
  // away, so a market carrying only one of them has no pair to speak of.
  assert.equal(isTeamShapedMarket(1_000_120, ["1"]), false);
  assert.equal(isTeamShapedMarket(1_000_120, ["2", "3"]), false);

  // A Fonbet head-to-head carries factor ids, not canonical ones.
  assert.equal(isTeamShapedMarket(1_000_399, ["714", "715"]), false);

  // A 2- or 3-way custom (operator-authored) market gets the canonical
  // ids on purpose; a wider one gets o1..oN precisely so it falls out.
  assert.equal(isTeamShapedMarket(2_000_000, ["1", "2"]), true);
  assert.equal(isTeamShapedMarket(2_000_000, ["o1", "o2", "o3"]), false);
});

// The admin fair-odds warning computes the clamp in SQL as
//   clamped   <=> bookKey <  1.0 + pct/100
//   swallowed <=> bookKey <= 1.0
// These pin that algebra against the real boostMarketKey, so a change to
// the clamp in one place can't silently diverge from the warning.
function sqlSaysClamped(odds: number[], pct: number): boolean {
  return bookKey(odds) < 1 + pct / 100;
}
function sqlSaysSwallowed(odds: number[]): boolean {
  return bookKey(odds) <= 1;
}
function actuallyClamped(odds: number[], pct: number): boolean {
  const r = boostMarketKey(odds, pct);
  return r.effectiveKeyDelta * 100 < pct - 1e-9;
}

test("SQL clamp predicate matches boostMarketKey on a normal book", () => {
  // ~5.3% overround (bookKey = 2/1.9 ≈ 1.0526), so a 3pp boost fits
  // inside the headroom and a 20pp one cannot.
  const odds = [1.9, 1.9];
  assert.ok(bookKey(odds) > 1.05 && bookKey(odds) < 1.06);
  for (const pct of [1, 3, 5, 5.5, 6, 10, 20, 50]) {
    assert.equal(
      sqlSaysClamped(odds, pct),
      actuallyClamped(odds, pct),
      `pct ${pct}`,
    );
  }
});

test("SQL clamp predicate matches boostMarketKey on a tight book", () => {
  // Barely any margin — almost every boost gets cut down.
  const odds = [2.02, 2.02];
  for (const pct of [0.5, 1, 2, 5, 25]) {
    assert.equal(
      sqlSaysClamped(odds, pct),
      actuallyClamped(odds, pct),
      `pct ${pct}`,
    );
  }
});

test("a book already at or past fair is reported swallowed and delivers nothing", () => {
  const fair = [2, 2]; // bookKey exactly 1.0
  assert.equal(bookKey(fair), 1);
  assert.equal(sqlSaysSwallowed(fair), true);
  assert.equal(boostMarketKey(fair, 10).effectiveKeyDelta, 0);

  const past = [2.5, 2.5]; // bookKey 0.8 — better than fair already
  assert.equal(sqlSaysSwallowed(past), true);
  assert.equal(boostMarketKey(past, 10).effectiveKeyDelta, 0);
});

test("best deliverable pct on a clamped market is (key - 1) * 100", () => {
  const odds = [1.9, 1.9];
  const key = bookKey(odds);
  const requested = 40; // far more than the book can give
  assert.equal(sqlSaysClamped(odds, requested), true);
  const delivered = boostMarketKey(odds, requested).effectiveKeyDelta * 100;
  // What the admin tooltip reports as the tightest market's ceiling.
  assert.ok(Math.abs(delivered - (key - 1) * 100) < 1e-9);
});

test("an untouched boost reports no clamp", () => {
  const odds = [3.0, 1.5]; // roughly 1.0 key... verify it has headroom
  const key = bookKey(odds);
  if (key <= 1.001) return; // nothing to assert on a fair book
  const pct = (key - 1) * 100 * 0.5; // half the available headroom
  assert.equal(sqlSaysClamped(odds, pct), false);
  assert.equal(actuallyClamped(odds, pct), false);
});
