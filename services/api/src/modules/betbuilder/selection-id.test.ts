// Locks the OBB selection_id wire format. The separator MUST be `|`
// (Oddin's canonical form) — a `&` here byte-mismatches Oddin's echoed
// selection_ids at placement, rejecting every BetBuilder ticket with
// `betbuilder_selection_mismatch`. Regression guard for that bug.
//
// Run with: tsx --test src/modules/betbuilder/selection-id.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildSelectionId } from "./selection-id.js";

describe("buildSelectionId", () => {
  it("joins specifiers with `|` and sorts keys (matches Oddin's echo)", () => {
    // Real shape observed from the integration broker's SessionCreate echo.
    assert.equal(
      buildSelectionId("od:match:2845425", 107, "od:player:45", {
        variant: "od:dynamic_outcomes:16502",
        map: "1",
        slot: "5",
      }),
      "od:match:2845425/107/od:player:45?map=1|slot=5|variant=od:dynamic_outcomes:16502",
    );
  });

  it("sorts keys lexicographically regardless of input order", () => {
    assert.equal(
      buildSelectionId("od:match:1", 169, "4", {
        threshold: "14.5",
        entity: "od:player:95",
        map: "1",
        slot: "4",
      }),
      "od:match:1/169/4?entity=od:player:95|map=1|slot=4|threshold=14.5",
    );
  });

  it("omits the query entirely when there are no specifiers", () => {
    assert.equal(buildSelectionId("od:match:1", 10, "2", {}), "od:match:1/10/2");
  });

  it("leaves Oddin's colon-bearing values unencoded", () => {
    assert.equal(
      buildSelectionId("od:match:1", 1, "1", { variant: "way:two", way: "two" }),
      "od:match:1/1/1?variant=way:two|way=two",
    );
  });
});
