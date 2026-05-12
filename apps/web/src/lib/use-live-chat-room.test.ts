// Unit tests for the room-state reducer. This is the heart of the UI
// state machine — anything observable in the panel (messages, bursts,
// crowd picks, viewer count, bet pin) is a projection of `RoomState`,
// so reducer correctness is a strong proxy for UI correctness.
//
// Run with: node --test --import tsx src/lib/use-live-chat-room.test.ts

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import type {
  LiveChatBroadcastFrame,
  LiveChatCrowdPicks,
  LiveChatMatchSnapshot,
  LiveChatRoomState,
  LiveChatSystemMessage,
  LiveChatUserMessage,
} from "@oddzilla/types/live-chat";
import {
  initialRoomState,
  roomReducer,
  type Action,
  type RoomState,
} from "./use-live-chat-room";

// ─── factories ──────────────────────────────────────────────────────────────

const matchSnap = (overrides?: Partial<LiveChatMatchSnapshot>): LiveChatMatchSnapshot => ({
  score: { home: 0, away: 0 },
  clock: "",
  status: "live",
  ...overrides,
});

const userMsg = (id: string, text = "hi"): LiveChatUserMessage => ({
  id,
  matchId: "1",
  kind: "user",
  userId: "u-1",
  nickname: "alex",
  avatarInitials: "AL",
  text,
  createdAt: "2026-05-12T10:00:00Z",
});

const systemMsg = (id: string, text = "Goal"): LiveChatSystemMessage => ({
  id,
  matchId: "1",
  kind: "system",
  systemKind: "goal",
  text,
  payload: null,
  createdAt: "2026-05-12T10:00:00Z",
});

const snapshot = (
  overrides?: Partial<LiveChatRoomState>,
): LiveChatRoomState => ({
  matchId: "1",
  match: matchSnap(),
  viewerCount: 3,
  myPick: null,
  crowdPicks: null,
  messages: [],
  betPin: null,
  ...overrides,
});

const picksUpdate = (
  cp: Partial<LiveChatCrowdPicks> = {},
): LiveChatBroadcastFrame => ({
  type: "chat_picks_update",
  matchId: "1",
  crowdPicks: { home: 1, draw: 0, away: 0, totalVotes: 1, ...cp },
});

// ─── snapshot ──────────────────────────────────────────────────────────────

describe("roomReducer: snapshot", () => {
  it("replaces state wholesale", () => {
    const seeded: RoomState = {
      ...initialRoomState(),
      viewerCount: 99,
      bursts: [
        { id: "x", nickname: "n", reaction: "goal", receivedAt: 0 },
      ],
    };
    const next = roomReducer(seeded, {
      type: "snapshot",
      snapshot: snapshot({ viewerCount: 4, messages: [userMsg("1")] }),
    });
    assert.equal(next.viewerCount, 4);
    assert.equal(next.messages.length, 1);
    assert.equal(next.bursts.length, 0, "bursts wiped on resnap");
  });

  it("truncates oversized message buffer", () => {
    // 250 messages from the API should be capped to the 200-buffer
    // limit. This guards against a future endpoint that returns more
    // history than the rolling cache wants to keep in React state.
    const msgs = Array.from({ length: 250 }, (_, i) => userMsg(String(i)));
    const next = roomReducer(initialRoomState(), {
      type: "snapshot",
      snapshot: snapshot({ messages: msgs }),
    });
    assert.equal(next.messages.length, 200);
    // We slice from the END (newest), so id 49 is the oldest survivor.
    assert.equal(next.messages[0]?.id, "50");
    assert.equal(next.messages[199]?.id, "249");
  });
});

// ─── chat_message frame ────────────────────────────────────────────────────

describe("roomReducer: chat_message frame", () => {
  it("appends a new message", () => {
    const next = roomReducer(initialRoomState(), {
      type: "frame",
      frame: { type: "chat_message", matchId: "1", message: userMsg("a") },
    });
    assert.equal(next.messages.length, 1);
    assert.equal(next.messages[0]?.id, "a");
  });

  it("dedupes by id when the server echoes back an optimistic message", () => {
    const seeded = roomReducer(initialRoomState(), {
      type: "optimistic_message",
      message: userMsg("a"),
    });
    const next = roomReducer(seeded, {
      type: "frame",
      frame: { type: "chat_message", matchId: "1", message: userMsg("a") },
    });
    assert.equal(next.messages.length, 1, "no double-append on echo");
  });

  it("caps the rolling buffer at 200 across many appends", () => {
    let state = initialRoomState();
    for (let i = 0; i < 220; i++) {
      state = roomReducer(state, {
        type: "frame",
        frame: {
          type: "chat_message",
          matchId: "1",
          message: userMsg(String(i)),
        },
      });
    }
    assert.equal(state.messages.length, 200);
    assert.equal(state.messages[0]?.id, "20", "oldest 20 dropped");
    assert.equal(state.messages[199]?.id, "219", "newest preserved");
  });

  it("handles system messages alongside user messages", () => {
    const a = roomReducer(initialRoomState(), {
      type: "frame",
      frame: { type: "chat_message", matchId: "1", message: userMsg("1") },
    });
    const b = roomReducer(a, {
      type: "frame",
      frame: { type: "chat_message", matchId: "1", message: systemMsg("2") },
    });
    assert.equal(b.messages.length, 2);
    assert.equal(b.messages[1]?.kind, "system");
  });
});

// ─── chat_picks_update frame (reveal-on-vote) ──────────────────────────────

describe("roomReducer: chat_picks_update reveal-on-vote", () => {
  it("DROPS the update when the viewer has not voted yet", () => {
    // Critical privacy invariant — every viewer in the room receives
    // the broadcast, but unvoted clients must not see the bars.
    const next = roomReducer(initialRoomState(), {
      type: "frame",
      frame: picksUpdate({ home: 5, draw: 2, away: 3, totalVotes: 10 }),
    });
    assert.equal(next.crowdPicks, null);
  });

  it("APPLIES the update when the viewer has voted", () => {
    const seeded = roomReducer(initialRoomState(), {
      type: "optimistic_pick",
      pick: "home",
      crowdPicks: { home: 1, draw: 0, away: 0, totalVotes: 1 },
    });
    const next = roomReducer(seeded, {
      type: "frame",
      frame: picksUpdate({ home: 5, draw: 2, away: 3, totalVotes: 10 }),
    });
    assert.ok(next.crowdPicks);
    assert.equal(next.crowdPicks?.totalVotes, 10);
  });
});

// ─── reaction frames ───────────────────────────────────────────────────────

describe("roomReducer: chat_reaction frame", () => {
  it("appends a burst keyed by burstId", () => {
    const next = roomReducer(initialRoomState(), {
      type: "frame",
      frame: {
        type: "chat_reaction",
        matchId: "1",
        userId: "u-2",
        nickname: "bob",
        reaction: "fire",
        burstId: "burst-1",
      },
    });
    assert.equal(next.bursts.length, 1);
    assert.equal(next.bursts[0]?.id, "burst-1");
    assert.equal(next.bursts[0]?.reaction, "fire");
  });

  it("preserves earlier bursts (newest pushed onto the tail)", () => {
    let s = initialRoomState();
    for (const id of ["a", "b", "c"]) {
      s = roomReducer(s, {
        type: "frame",
        frame: {
          type: "chat_reaction",
          matchId: "1",
          userId: "u-2",
          nickname: "bob",
          reaction: "goal",
          burstId: id,
        },
      });
    }
    assert.deepEqual(
      s.bursts.map((b) => b.id),
      ["a", "b", "c"],
    );
  });
});

// ─── chat_match_update + viewer_count ──────────────────────────────────────

describe("roomReducer: header updates", () => {
  it("replaces the match snapshot on chat_match_update", () => {
    const next = roomReducer(initialRoomState(), {
      type: "frame",
      frame: {
        type: "chat_match_update",
        matchId: "1",
        match: matchSnap({ score: { home: 2, away: 1 }, status: "live" }),
      },
    });
    assert.deepEqual(next.match?.score, { home: 2, away: 1 });
  });

  it("updates viewer count on chat_viewer_count", () => {
    const next = roomReducer(initialRoomState(), {
      type: "frame",
      frame: { type: "chat_viewer_count", matchId: "1", viewerCount: 12 },
    });
    assert.equal(next.viewerCount, 12);
  });
});

// ─── optimistic actions ────────────────────────────────────────────────────

describe("roomReducer: optimistic_message", () => {
  it("appends the message immediately", () => {
    const next = roomReducer(initialRoomState(), {
      type: "optimistic_message",
      message: userMsg("a", "send-only"),
    });
    assert.equal(next.messages.length, 1);
    assert.equal(next.messages[0]?.text, "send-only");
  });

  it("is idempotent when called twice with the same id", () => {
    // Otherwise a slow network with retries would double-print.
    let s = roomReducer(initialRoomState(), {
      type: "optimistic_message",
      message: userMsg("a"),
    });
    s = roomReducer(s, {
      type: "optimistic_message",
      message: userMsg("a"),
    });
    assert.equal(s.messages.length, 1);
  });
});

describe("roomReducer: optimistic_pick", () => {
  it("sets myPick + crowdPicks together so reveal-on-vote unlocks", () => {
    const next = roomReducer(initialRoomState(), {
      type: "optimistic_pick",
      pick: "draw",
      crowdPicks: { home: 1, draw: 1, away: 0, totalVotes: 2 },
    });
    assert.equal(next.myPick, "draw");
    assert.equal(next.crowdPicks?.totalVotes, 2);
  });
});

// ─── burst GC ──────────────────────────────────────────────────────────────

describe("roomReducer: expire_bursts", () => {
  it("drops bursts older than the cutoff", () => {
    const seeded: RoomState = {
      ...initialRoomState(),
      bursts: [
        { id: "old", nickname: "a", reaction: "goal", receivedAt: 100 },
        { id: "newer", nickname: "b", reaction: "fire", receivedAt: 1000 },
      ],
    };
    const next = roomReducer(seeded, {
      type: "expire_bursts",
      cutoffMs: 500,
    });
    assert.equal(next.bursts.length, 1);
    assert.equal(next.bursts[0]?.id, "newer");
  });

  it("is a no-op when nothing is past cutoff", () => {
    const seeded: RoomState = {
      ...initialRoomState(),
      bursts: [
        { id: "x", nickname: "a", reaction: "goal", receivedAt: 1000 },
      ],
    };
    const next = roomReducer(seeded, {
      type: "expire_bursts",
      cutoffMs: 100,
    });
    assert.equal(next.bursts.length, 1);
  });
});

// ─── invariants ────────────────────────────────────────────────────────────

// ─── deriveLiveStatus (BetPin) ─────────────────────────────────────────────

import { deriveLiveStatus } from "../components/match-room/match-room";

const matchAt = (home: number, away: number): LiveChatMatchSnapshot => ({
  score: { home, away },
  clock: "",
  status: "live",
});

const betPin = (
  pickedSide: "home" | "draw" | "away" | null,
  status: "pending" | "won" | "lost" | "void" | "cashed_out" = "pending",
) => ({
  ticketId: "t-1",
  outcomeLabel: pickedSide ?? "Custom",
  oddsX10000: 25000,
  stakeMicro: "10000000",
  potentialWinMicro: "25000000",
  currency: "USDC",
  status,
  pickedSide,
});

describe("deriveLiveStatus", () => {
  it("returns null when there is no bet pin", () => {
    assert.equal(deriveLiveStatus(null, matchAt(2, 1)), null);
  });

  it("returns null when the match snapshot is absent", () => {
    assert.equal(deriveLiveStatus(betPin("home"), null), null);
  });

  it("returns null for terminal lifecycle statuses (no derivation)", () => {
    // Won/lost/void/cashed_out colours come from betPin.status; the
    // live derivation is for in-flight bets only.
    assert.equal(deriveLiveStatus(betPin("home", "won"), matchAt(2, 1)), null);
    assert.equal(deriveLiveStatus(betPin("home", "lost"), matchAt(1, 2)), null);
    assert.equal(deriveLiveStatus(betPin("home", "void"), matchAt(0, 0)), null);
    assert.equal(
      deriveLiveStatus(betPin("home", "cashed_out"), matchAt(1, 0)),
      null,
    );
  });

  it("returns null when pickedSide is null (unknown market shape)", () => {
    // The UI falls back to the raw label; no colour treatment.
    assert.equal(deriveLiveStatus(betPin(null), matchAt(1, 0)), null);
  });

  describe("home pick", () => {
    it("winning when home is ahead", () => {
      assert.equal(deriveLiveStatus(betPin("home"), matchAt(2, 1)), "winning");
    });
    it("at_risk when home is behind", () => {
      assert.equal(deriveLiveStatus(betPin("home"), matchAt(0, 1)), "at_risk");
    });
    it("level when scores are equal", () => {
      assert.equal(deriveLiveStatus(betPin("home"), matchAt(1, 1)), "level");
    });
  });

  describe("away pick", () => {
    it("winning when away is ahead", () => {
      assert.equal(deriveLiveStatus(betPin("away"), matchAt(0, 1)), "winning");
    });
    it("at_risk when away is behind", () => {
      assert.equal(deriveLiveStatus(betPin("away"), matchAt(2, 1)), "at_risk");
    });
    it("level when scores are equal", () => {
      assert.equal(deriveLiveStatus(betPin("away"), matchAt(0, 0)), "level");
    });
  });

  describe("draw pick", () => {
    it("winning when scores are level", () => {
      // A draw bet is only "winning" while the scores are tied —
      // any goal turns it into at_risk.
      assert.equal(deriveLiveStatus(betPin("draw"), matchAt(0, 0)), "winning");
      assert.equal(deriveLiveStatus(betPin("draw"), matchAt(2, 2)), "winning");
    });
    it("at_risk when scores diverge in either direction", () => {
      assert.equal(deriveLiveStatus(betPin("draw"), matchAt(1, 0)), "at_risk");
      assert.equal(deriveLiveStatus(betPin("draw"), matchAt(0, 1)), "at_risk");
      assert.equal(deriveLiveStatus(betPin("draw"), matchAt(3, 1)), "at_risk");
    });
  });
});

describe("roomReducer: cross-cutting invariants", () => {
  it("never mutates the previous state object", () => {
    // Cheap "did we accidentally write `state.foo = ...`" check.
    const prev = initialRoomState();
    const frozenSnapshot = JSON.stringify(prev);
    const actions: Action[] = [
      { type: "snapshot", snapshot: snapshot() },
      {
        type: "frame",
        frame: { type: "chat_message", matchId: "1", message: userMsg("a") },
      },
      {
        type: "frame",
        frame: { type: "chat_viewer_count", matchId: "1", viewerCount: 9 },
      },
      {
        type: "optimistic_pick",
        pick: "home",
        crowdPicks: { home: 1, draw: 0, away: 0, totalVotes: 1 },
      },
    ];
    for (const a of actions) roomReducer(prev, a);
    assert.equal(JSON.stringify(prev), frozenSnapshot, "prev mutated");
  });
});
