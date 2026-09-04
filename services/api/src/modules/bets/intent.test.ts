// Unit tests for placement intent tokens.
//
// Run with: tsx --test src/modules/bets/intent.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  checkIntent,
  deriveIntentKey,
  newIntentClaims,
  selectionSetHash,
  signIntent,
  verifyIntent,
} from "./intent.js";

const KEY = deriveIntentKey("test-jwt-secret-that-is-long-enough-to-matter");
const OTHER_KEY = deriveIntentKey("a-different-secret");
const USER = "11111111-2222-3333-4444-555555555555";
const SELS = [
  { marketId: "42", outcomeId: "1" },
  { marketId: "7", outcomeId: "2" },
];

describe("selectionSetHash", () => {
  it("is order-independent and duplicate-insensitive", () => {
    const a = selectionSetHash(SELS);
    const b = selectionSetHash([...SELS].reverse());
    const c = selectionSetHash([...SELS, SELS[0]!]);
    assert.equal(a, b);
    assert.equal(a, c);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it("changes when any leg changes", () => {
    const a = selectionSetHash(SELS);
    const b = selectionSetHash([SELS[0]!, { marketId: "7", outcomeId: "1" }]);
    assert.notEqual(a, b);
  });
});

describe("sign / verify", () => {
  it("round-trips a claim set", () => {
    const claims = newIntentClaims(USER, SELS, 1_700_000_000_000);
    const token = signIntent(claims, KEY);
    assert.deepEqual(verifyIntent(token, KEY), claims);
  });

  it("rejects a token signed with a different key", () => {
    const token = signIntent(newIntentClaims(USER, SELS), KEY);
    assert.equal(verifyIntent(token, OTHER_KEY), null);
  });

  it("rejects a tampered body", () => {
    const claims = newIntentClaims(USER, SELS, 1_700_000_000_000);
    const token = signIntent(claims, KEY);
    const [body, mac] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...claims, t: claims.t - 60_000 }),
      "utf8",
    ).toString("base64url");
    assert.equal(verifyIntent(`${forged}.${mac}`, KEY), null);
    assert.equal(verifyIntent(`${body}.AAAA`, KEY), null);
  });

  it("rejects garbage", () => {
    assert.equal(verifyIntent("", KEY), null);
    assert.equal(verifyIntent("nodot", KEY), null);
    assert.equal(verifyIntent(".", KEY), null);
    assert.equal(verifyIntent(42, KEY), null);
    assert.equal(verifyIntent("x".repeat(3000), KEY), null);
  });
});

describe("checkIntent", () => {
  const issued = 1_700_000_000_000;
  const base = { userId: USER, selections: SELS, ttlMs: 120_000, minHumanMs: 600 };
  const token = signIntent(newIntentClaims(USER, SELS, issued), KEY);

  it("accepts inside the window", () => {
    const r = checkIntent(token, KEY, { ...base, nowMs: issued + 2_000 });
    assert.equal(r.ok, true);
  });

  it("rejects a confirm faster than the minimum human time, keeping the claims", () => {
    const r = checkIntent(token, KEY, { ...base, nowMs: issued + 200 });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "intent_too_fast");
      assert.ok(r.claims);
    }
  });

  it("accepts exactly at the minimum human time", () => {
    const r = checkIntent(token, KEY, { ...base, nowMs: issued + 600 });
    assert.equal(r.ok, true);
  });

  it("rejects an expired token, keeping the claims", () => {
    const r = checkIntent(token, KEY, { ...base, nowMs: issued + 120_001 });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "intent_expired");
      assert.ok(r.claims);
    }
  });

  it("rejects a token minted for another user", () => {
    const r = checkIntent(token, KEY, {
      ...base,
      userId: "99999999-2222-3333-4444-555555555555",
      nowMs: issued + 2_000,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "intent_invalid");
  });

  it("rejects a token for a different selection set", () => {
    const r = checkIntent(token, KEY, {
      ...base,
      selections: [SELS[0]!],
      nowMs: issued + 2_000,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "intent_selection_mismatch");
  });

  it("rejects a future-dated token", () => {
    const r = checkIntent(token, KEY, { ...base, nowMs: issued - 60_000 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "intent_invalid");
  });

  it("treats minHumanMs = 0 as disabled", () => {
    const r = checkIntent(token, KEY, { ...base, minHumanMs: 0, nowMs: issued });
    assert.equal(r.ok, true);
  });
});
