// Unit tests for the canonical-name batch splitter.
//
// The index re-basing here is the part worth pinning: names come back
// keyed by position WITHIN the call, so a half-batch answers with 0..n
// and those have to be shifted onto the parent batch's positions. Get it
// wrong and every tournament in the second half is handed its
// neighbour's canonical name — which does not fail, it just puts the
// WRONG logo on a real competition, exactly the outcome every guard in
// wikidata.ts exists to prevent.
//
// Run with: tsx --test src/lib/tournament-logos/resolver.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { nameBatch } from "./resolver.js";
import { ZagiEmptyReplyError } from "../zagi/client.js";
import type { LogoItem } from "./resolver.js";

function items(n: number): LogoItem[] {
  return Array.from({ length: n }, (_, i) => ({
    tournamentId: 1000 + i,
    name: `Comp ${i}`,
    categoryName: "Country",
    sportSlug: "football",
  }));
}

/**
 * A stub that answers with each item's own name, so a misplaced index
 * shows up as a mismatch rather than passing silently. `failAbove` makes
 * any call larger than that size die the way the real model does when it
 * spends its whole budget reasoning.
 */
function stubZagi(failAbove: number, calls: number[] = []) {
  return {
    calls,
    async complete({ user }: { system: string; user: string }) {
      const lines = user.split("\n").filter((l) => l.includes("name:"));
      calls.push(lines.length);
      if (lines.length > failAbove) throw new ZagiEmptyReplyError("length");
      const arr = lines.map((l, i) => ({
        i,
        name: l.split("name:")[1]!.trim(),
        aliases: [],
      }));
      return { text: JSON.stringify(arr), finishReason: "stop", usage: {} } as never;
    },
  };
}

describe("nameBatch", () => {
  it("returns names keyed by position when the call succeeds", async () => {
    const z = stubZagi(100);
    const batch = items(5);
    const out = await nameBatch(z, batch);
    assert.equal(out.size, 5);
    for (let i = 0; i < 5; i += 1) assert.equal(out.get(i)?.name, `Comp ${i}`);
    assert.deepEqual(z.calls, [5]);
  });

  it("splits on an empty reply and keeps every index aligned", async () => {
    // 24 items, model can only manage 12 at a time → one split.
    const z = stubZagi(12);
    const batch = items(24);
    const out = await nameBatch(z, batch);
    assert.equal(out.size, 24);
    for (let i = 0; i < 24; i += 1) {
      assert.equal(out.get(i)?.name, `Comp ${i}`, `index ${i} carries the wrong name`);
    }
    assert.deepEqual(z.calls, [24, 12, 12]);
  });

  it("splits repeatedly when halving once is not enough", async () => {
    const z = stubZagi(6);
    const batch = items(24);
    const out = await nameBatch(z, batch);
    assert.equal(out.size, 24);
    for (let i = 0; i < 24; i += 1) assert.equal(out.get(i)?.name, `Comp ${i}`);
  });

  it("stops splitting at the floor rather than cascading to singles", async () => {
    // Nothing ever succeeds: the error must surface instead of turning
    // one dead batch into 25 dead calls.
    const z = stubZagi(0);
    await assert.rejects(() => nameBatch(z, items(25)), ZagiEmptyReplyError);
    for (const n of z.calls) assert.ok(n >= 4, `called with ${n}, below the floor of 4`);
  });

  it("never splits a failure that is not a budget exhaustion", async () => {
    let calls = 0;
    const z = {
      async complete() {
        calls += 1;
        throw new Error("connect ECONNREFUSED");
      },
    };
    await assert.rejects(() => nameBatch(z as never, items(25)), /ECONNREFUSED/);
    assert.equal(calls, 1, "a transport failure must not be retried in halves");
  });
});
