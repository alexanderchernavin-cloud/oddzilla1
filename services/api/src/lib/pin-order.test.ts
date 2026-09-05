// Unit tests for the operator pin-ordering transform (migration 0103).
//
// Run with: tsx --test src/lib/pin-order.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { reorderPinned } from "./pin-order.js";

describe("reorderPinned", () => {
  it("pins an unpinned row to the front with 'top'", () => {
    assert.deepEqual(reorderPinned([1, 2, 3], 9, "top"), [9, 1, 2, 3]);
  });

  it("moves an already-pinned row to the front without duplicating it", () => {
    assert.deepEqual(reorderPinned([1, 2, 3], 3, "top"), [3, 1, 2]);
  });

  it("swaps with the previous row on 'up'", () => {
    assert.deepEqual(reorderPinned([1, 2, 3], 3, "up"), [1, 3, 2]);
  });

  it("swaps with the next row on 'down'", () => {
    assert.deepEqual(reorderPinned([1, 2, 3], 1, "down"), [2, 1, 3]);
  });

  // The boundary buttons are disabled in the UI, but a double-click that
  // races a refresh must not 500 — both ends are no-ops.
  it("is a no-op at the boundaries", () => {
    assert.deepEqual(reorderPinned([1, 2, 3], 1, "up"), [1, 2, 3]);
    assert.deepEqual(reorderPinned([1, 2, 3], 3, "down"), [1, 2, 3]);
  });

  it("appends an unpinned row on 'up' / 'down' rather than failing", () => {
    assert.deepEqual(reorderPinned([1, 2], 7, "up"), [1, 2, 7]);
    assert.deepEqual(reorderPinned([1, 2], 7, "down"), [1, 2, 7]);
  });

  it("removes the row on 'clear' and leaves the rest in order", () => {
    assert.deepEqual(reorderPinned([1, 2, 3], 2, "clear"), [1, 3]);
  });

  it("ignores 'clear' for a row that was never pinned", () => {
    assert.deepEqual(reorderPinned([1, 2], 8, "clear"), [1, 2]);
  });

  // display_order carries no uniqueness constraint, so two rows can
  // arrive sharing a value and sort into the read in either order. The
  // transform collapses the duplicate so the write that follows heals it.
  it("collapses duplicates fed in by a degenerate read", () => {
    assert.deepEqual(reorderPinned([1, 2, 2, 3], 3, "top"), [3, 1, 2]);
  });

  it("does not mutate its input", () => {
    const input = [1, 2, 3];
    reorderPinned(input, 3, "top");
    assert.deepEqual(input, [1, 2, 3]);
  });

  it("pins the first row of an empty scope", () => {
    assert.deepEqual(reorderPinned([], 5, "top"), [5]);
  });
});
