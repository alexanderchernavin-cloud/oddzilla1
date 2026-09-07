import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  FONBET_HEAD_TO_HEAD_PMIDS,
  FONBET_PMID_BASE,
  isMatchWinnerMarket,
  isWinnerOutcomeId,
  WINNER_OUTCOME_IDS,
} from "./match-winner-market.js";

describe("isMatchWinnerMarket", () => {
  test("takes Oddin's market 1 on the id alone", () => {
    // Oddin's outcome ids are canonical too, but a 2-way esports winner
    // carries only "1" / "2" and the id is unambiguous, so it short-circuits.
    assert.equal(isMatchWinnerMarket({ providerMarketId: 1, outcomeIds: ["1", "2"] }), true);
    assert.equal(isMatchWinnerMarket({ providerMarketId: 1, outcomeIds: [] }), true);
  });

  test("rejects Oddin's map winner — that is a map, not the match", () => {
    assert.equal(isMatchWinnerMarket({ providerMarketId: 4, outcomeIds: ["1", "2"] }), false);
  });

  test("takes a Fonbet full-match result row by its canonical outcome ids", () => {
    // Real row, production 2026-09-07: market 425171448 on Real Madrid vs
    // Inter Milan, table 1000120, specifiers {}.
    assert.equal(
      isMatchWinnerMarket({
        providerMarketId: FONBET_PMID_BASE + 120,
        outcomeIds: ["1", "2", "3"],
      }), true);
  });

  test("rejects the sub-event copies of that same table", () => {
    // The bug this rule exists for: "2nd half: Match result" and
    // "Corners: Match result" share table 1000120 with the full match and
    // are told apart only by keeping their raw factor ids. Ranking by
    // provider_market_id could not separate them, so insertion order did,
    // and the 2nd half won.
    const subEventFactorIds = ["921", "922", "923", "924", "925", "1571"];
    for (const table of [120, 400_100, 400_200]) {
      assert.equal(
        isMatchWinnerMarket({
          providerMarketId: FONBET_PMID_BASE + table,
          outcomeIds: subEventFactorIds,
        }), false);
    }
  });

  test("rejects the split-off double-chance market", () => {
    // Real row, production 2026-09-07: market 425171406, the full match's
    // double chance, which the ingester files at 1_900_000 + table.
    assert.equal(
      isMatchWinnerMarket({
        providerMarketId: 1_900_000 + 120,
        outcomeIds: ["924", "925", "1571"],
      }),
      false,
    );
  });

  test("rejects a Fonbet head-to-head row — its ids are factor ids", () => {
    // It IS the winner of such a fixture, but the readers pair it as an
    // explicit fallback (see FONBET_HEAD_TO_HEAD_PMIDS); it must not pass
    // the canonical test and claim the headline slot silently.
    for (const pmid of FONBET_HEAD_TO_HEAD_PMIDS) {
      assert.equal(isMatchWinnerMarket({ providerMarketId: pmid, outcomeIds: ["714", "715"] }), 
        false,
      );
    }
  });

  test("needs two canonical ids, so a factor table holding a stray '1' is not a winner", () => {
    assert.equal(
      isMatchWinnerMarket({
        providerMarketId: FONBET_PMID_BASE + 500,
        outcomeIds: ["1", "807", "808", "809"],
      }), false);
  });

  test("takes a custom operator market — same canonical ids, on purpose", () => {
    // CUSTOM_PROVIDER_MARKET_ID is 2_000_000, above the Fonbet base. A
    // 2- or 3-way custom market is given these ids so it prices on cards;
    // wider ones get o1..oN precisely so they fall out here.
    assert.equal(isMatchWinnerMarket({ providerMarketId: 2_000_000, outcomeIds: ["1", "2"] }), 
      true,
    );
    assert.equal(
      isMatchWinnerMarket({
        providerMarketId: 2_000_000,
        outcomeIds: ["o1", "o2", "o3", "o4", "o5"],
      }), false);
  });

  test("rejects an Oddin market below the Fonbet base whatever its outcomes", () => {
    // Oddin market 156 (round handicap) also carries "1" / "2"; only
    // market 1 is the match winner on that feed.
    assert.equal(isMatchWinnerMarket({ providerMarketId: 156, outcomeIds: ["1", "2"] }), false);
  });
});

describe("winner outcome ids", () => {
  test("covers home / away / draw and nothing else", () => {
    assert.deepEqual([...WINNER_OUTCOME_IDS], ["1", "2", "3"]);
    assert.equal(isWinnerOutcomeId("1"), true);
    assert.equal(isWinnerOutcomeId("3"), true);
    // Fonbet's double chance: the three extra columns of the same result
    // table that a match banner must not offer.
    for (const dc of ["924", "925", "1571"]) assert.equal(isWinnerOutcomeId(dc), false);
  });
});
