// Unit tests for the pure helpers in routes.ts. The cache and DB
// paths need a Redis/Postgres harness; these tests cover the wire-
// shape contract that the UI relies on.
//
// Run with: node --test --import tsx src/modules/live-chat/helpers.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { avatarInitials, matchSnapshot, parseMatchId } from "./routes.js";

describe("avatarInitials", () => {
  it("uppercases the first two letters of a normal handle", () => {
    assert.equal(avatarInitials("alex"), "AL");
    assert.equal(avatarInitials("Visharad"), "VI");
  });

  it("strips non-alphanumerics before slicing", () => {
    // The Notion spec allows underscores in nicknames; the avatar
    // chip shouldn't render "_a".
    assert.equal(avatarInitials("_alex"), "AL");
    assert.equal(avatarInitials("a_b_c"), "AB");
  });

  it("preserves digits", () => {
    assert.equal(avatarInitials("u1"), "U1");
  });

  it("falls back when the stripped form is empty", () => {
    // Pathological input — shouldn't happen given the DB CHECK on
    // nickname format ([A-Za-z0-9_]{3,20}) — but the helper must not
    // crash if it ever does.
    assert.equal(avatarInitials("__"), "__");
  });
});

describe("matchSnapshot", () => {
  const base = { homeTeam: "Arsenal", awayTeam: "Chelsea" };

  it("maps DB match_status to wire-format status", () => {
    assert.equal(
      matchSnapshot({ ...base, status: "not_started", liveScore: null }).status,
      "not_started",
    );
    assert.equal(
      matchSnapshot({ ...base, status: "live", liveScore: null }).status,
      "live",
    );
    assert.equal(
      matchSnapshot({ ...base, status: "closed", liveScore: null }).status,
      "fulltime",
    );
    assert.equal(
      matchSnapshot({ ...base, status: "cancelled", liveScore: null }).status,
      "fulltime",
    );
    assert.equal(
      matchSnapshot({ ...base, status: "suspended", liveScore: null }).status,
      "suspended",
    );
  });

  it("returns 0-0 when liveScore is absent", () => {
    const s = matchSnapshot({ ...base, status: "not_started", liveScore: null });
    assert.deepEqual(s.score, { home: 0, away: 0 });
    assert.equal(s.clock, "");
  });

  it("parses { home, away, clock } from liveScore", () => {
    const s = matchSnapshot({
      ...base,
      status: "live",
      liveScore: { home: 2, away: 1, clock: "74'" },
    });
    assert.deepEqual(s.score, { home: 2, away: 1 });
    assert.equal(s.clock, "74'");
  });

  it("accepts short field aliases (h/a) some feeds use", () => {
    const s = matchSnapshot({
      ...base,
      status: "live",
      liveScore: { h: 3, a: 0 },
    });
    assert.deepEqual(s.score, { home: 3, away: 0 });
  });

  it("clamps non-numeric scores to 0", () => {
    const s = matchSnapshot({
      ...base,
      status: "live",
      // Defensive: an Oddin payload with a stringified score
      // shouldn't surface NaN to the UI.
      liveScore: { home: "lol", away: null },
    });
    assert.deepEqual(s.score, { home: 0, away: 0 });
  });

  it("ignores non-object liveScore payloads", () => {
    const s = matchSnapshot({
      ...base,
      status: "live",
      liveScore: "bogus",
    });
    assert.deepEqual(s.score, { home: 0, away: 0 });
    assert.equal(s.clock, "");
  });
});

describe("parseMatchId", () => {
  it("accepts a positive decimal bigint as a string", () => {
    assert.equal(parseMatchId("1"), "1");
    assert.equal(parseMatchId("90001"), "90001");
    // 19-digit max — fits comfortably inside signed bigint.
    assert.equal(parseMatchId("1234567890123456789"), "1234567890123456789");
  });

  it("rejects leading zeros, signs, and non-digits", () => {
    for (const bad of [
      "0",
      "01",
      "-1",
      "+1",
      "1.0",
      "abc",
      "1abc",
      "",
      " 1",
      "1 ",
      "1_2",
      // Past the 19-digit cap — would overflow signed bigint.
      "12345678901234567890",
    ]) {
      assert.throws(() => parseMatchId(bad), /match_id_invalid/, bad);
    }
  });
});
