// Unit tests for the `derivePickedSide` server-side helper. Pins the
// (providerMarketId, outcomeId) → home/draw/away mapping that the
// client's live-status derivation depends on.
//
// Run with: node --test --import tsx src/modules/live-chat/picked-side.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { derivePickedSide } from "./routes.js";

describe("derivePickedSide", () => {
  describe("match-winner market (providerMarketId=1)", () => {
    it("maps outcomeId '1' to home", () => {
      assert.equal(derivePickedSide(1, "1"), "home");
    });

    it("maps outcomeId 'X' to draw", () => {
      // Esports BO-N markets typically have no draw outcome at all,
      // but a few traditional sports do. The mapping must hold for
      // both shapes so the watcher doesn't need to know the sport.
      assert.equal(derivePickedSide(1, "X"), "draw");
    });

    it("maps outcomeId '2' to away", () => {
      assert.equal(derivePickedSide(1, "2"), "away");
    });

    it("returns null for unrecognised outcomeIds on the same market", () => {
      // Defensive: an Oddin variant of the match-winner market could
      // emit a different outcome alphabet (handicap markets, for
      // instance, layer onto provider_market_id=1 in some sports).
      // We never guess; the UI falls back to the raw label.
      assert.equal(derivePickedSide(1, "3"), null);
      assert.equal(derivePickedSide(1, "team_a"), null);
      assert.equal(derivePickedSide(1, ""), null);
    });
  });

  describe("non-match-winner markets", () => {
    it("returns null for the map-winner market (provider_market_id=4)", () => {
      // Map-winner derivation requires joining against
      // home_team_urn / away_team_urn — V1 doesn't ship it. The
      // BetPin renders raw labels until that lands.
      assert.equal(derivePickedSide(4, "1"), null);
    });

    it("returns null for totals / BTTS / handicap shapes", () => {
      // None of these have a home/away geometric axis, so the live
      // status colour wouldn't be meaningful anyway.
      for (const pmId of [10, 18, 19, 25, 50, 188]) {
        assert.equal(derivePickedSide(pmId, "1"), null, `pmId=${pmId}`);
      }
    });

    it("returns null when providerMarketId is null", () => {
      // The DB column is non-null, but the wider system has been
      // bitten by NULL-on-recovery edge cases before — be defensive.
      assert.equal(derivePickedSide(null, "1"), null);
    });
  });
});
