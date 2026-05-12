// Pure-helper tests for the match-state watcher. The pub/sub loop
// needs a Redis fixture; these tests cover the delta detector +
// formatter that the system-message wire format depends on.
//
// Run with: node --test --import tsx src/modules/live-chat/match-watcher.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type { WatcherMatchState } from "./match-watcher.js";
import {
  detectSystemEvents,
  formatSystemMessage,
  parseLiveScoreFrame,
  snapshotFromLiveScore,
} from "./match-watcher.js";

const stateOf = (
  home: number,
  away: number,
  status: number | null = 1,
): WatcherMatchState => ({ home, away, status });

describe("detectSystemEvents", () => {
  it("emits nothing on cold start", () => {
    // Restart should not spray "Score" messages for matches already
    // in progress. The first frame seeds prev silently.
    assert.deepEqual(detectSystemEvents(null, stateOf(2, 1)), []);
  });

  it("emits a goal when home score increases", () => {
    const events = detectSystemEvents(stateOf(0, 0), stateOf(1, 0));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "goal");
    assert.equal((events[0] as { side: string }).side, "home");
  });

  it("emits a goal when away score increases", () => {
    const events = detectSystemEvents(stateOf(1, 0), stateOf(1, 1));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "goal");
    assert.equal((events[0] as { side: string }).side, "away");
  });

  it("emits two goals when both sides increase in the same frame", () => {
    // Rare in football, normal in esports where a map flip can
    // bump both series totals on a final-frame replay.
    const events = detectSystemEvents(stateOf(0, 0), stateOf(1, 1));
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((e) => e.kind),
      ["goal", "goal"],
    );
  });

  it("never emits a goal on score decrease (Oddin rollback)", () => {
    // A rollback message can revise a previously-published score
    // downward. We don't want to fabricate a goal in that case.
    assert.deepEqual(detectSystemEvents(stateOf(2, 1), stateOf(1, 1)), []);
  });

  it("emits full_time on first transition to closed", () => {
    const events = detectSystemEvents(stateOf(1, 0, 1), stateOf(1, 0, 4));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "full_time");
  });

  it("does NOT re-emit full_time when both prev and curr are closed", () => {
    // Replays / late updates on already-settled matches should be
    // silent. Otherwise the same room emits FT twice on a recovery
    // flush.
    assert.deepEqual(detectSystemEvents(stateOf(1, 0, 4), stateOf(1, 0, 4)), []);
  });

  it("emits match_cancelled on transition to status 5", () => {
    const events = detectSystemEvents(stateOf(0, 0, 1), stateOf(0, 0, 5));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "match_cancelled");
  });

  it("emits a goal AND full_time when the last goal lands with the final whistle", () => {
    // Real-world example: stoppage-time goal arrives in the same
    // message as the status flip to closed. Both events must fire,
    // goal first.
    const events = detectSystemEvents(
      stateOf(1, 1, 1),
      stateOf(2, 1, 4),
    );
    assert.equal(events.length, 2);
    assert.equal(events[0]?.kind, "goal");
    assert.equal(events[1]?.kind, "full_time");
  });

  it("ignores unknown status codes (Oddin defensive)", () => {
    // Codes 2, 3, 6, 7, 8, 9 are undocumented per Oddin spec
    // §2.4.1.2 — feed-ingester refuses them entirely. The watcher
    // treats them as "no transition" so the room state isn't
    // poisoned by a malformed feed.
    assert.deepEqual(detectSystemEvents(stateOf(0, 0, 1), stateOf(0, 0, 6)), []);
    assert.deepEqual(detectSystemEvents(stateOf(0, 0, 1), stateOf(0, 0, 99)), []);
  });
});

describe("formatSystemMessage", () => {
  const match = { homeTeam: "Arsenal", awayTeam: "Chelsea" };

  it("formats a home goal without emoji prefix", () => {
    const out = formatSystemMessage(
      { kind: "goal", side: "home", homeScore: 2, awayScore: 1 },
      match,
      stateOf(2, 1, 1),
    );
    assert.equal(out.systemKind, "goal");
    assert.equal(out.text, "Score - Arsenal 2-1 Chelsea");
    // No emoji characters anywhere in the text. CLAUDE.md invariant 8.
    assert.equal(/[\u{1F000}-\u{1FFFF}]/u.test(out.text), false);
  });

  it("formats full time with the final score", () => {
    const out = formatSystemMessage(
      { kind: "full_time", homeScore: 2, awayScore: 1 },
      match,
      stateOf(2, 1, 4),
    );
    assert.equal(out.systemKind, "full_time");
    assert.equal(out.text, "Full Time - Arsenal 2-1 Chelsea");
    assert.equal(out.payload.status, "fulltime");
  });

  it("formats cancellation with the team names", () => {
    const out = formatSystemMessage(
      { kind: "match_cancelled" },
      match,
      stateOf(0, 0, 5),
    );
    assert.equal(out.systemKind, "match_cancelled");
    assert.equal(out.text, "Match cancelled - Arsenal vs Chelsea");
  });

  it("encodes the current score in payload.score", () => {
    const out = formatSystemMessage(
      { kind: "goal", side: "away", homeScore: 1, awayScore: 2 },
      match,
      stateOf(1, 2, 1),
    );
    assert.deepEqual(out.payload.score, { home: 1, away: 2 });
    assert.equal(out.payload.status, "live");
  });
});

describe("parseLiveScoreFrame", () => {
  it("accepts the canonical feed-ingester envelope", () => {
    const raw = JSON.stringify({
      type: "score",
      matchId: "90001",
      liveScore: { home: 2, away: 1, status: 1 },
    });
    const f = parseLiveScoreFrame(raw);
    assert.ok(f);
    assert.equal(f.matchId, "90001");
    assert.equal(f.liveScore.home, 2);
  });

  it("returns null for odds frames", () => {
    // odds-publisher emits `{type:"odds", ...}` on the same channel.
    // The watcher only cares about score frames.
    const raw = JSON.stringify({
      type: "odds",
      matchId: "90001",
      marketId: "1",
    });
    assert.equal(parseLiveScoreFrame(raw), null);
  });

  it("returns null for malformed JSON", () => {
    assert.equal(parseLiveScoreFrame("{not json"), null);
  });

  it("returns null when matchId is missing", () => {
    const raw = JSON.stringify({ type: "score", liveScore: { home: 1 } });
    assert.equal(parseLiveScoreFrame(raw), null);
  });

  it("returns null when liveScore is not an object", () => {
    const raw = JSON.stringify({
      type: "score",
      matchId: "90001",
      liveScore: "nope",
    });
    assert.equal(parseLiveScoreFrame(raw), null);
  });
});

describe("snapshotFromLiveScore", () => {
  it("treats missing fields as zero scores and null status", () => {
    const s = snapshotFromLiveScore({});
    assert.deepEqual(s, { home: 0, away: 0, status: null });
  });

  it("coerces numeric-string scores to numbers", () => {
    // Defensive: Oddin pushes integers, but JSON.parse could yield a
    // string if the upstream shape ever drifts.
    const s = snapshotFromLiveScore({
      home: "2" as unknown as number,
      away: "1" as unknown as number,
      status: 1,
    });
    assert.equal(s.home, 2);
    assert.equal(s.away, 1);
  });

  it("rejects NaN scores", () => {
    const s = snapshotFromLiveScore({
      home: Number.NaN,
      away: 0,
    });
    assert.equal(s.home, 0);
  });
});
