"use client";

// Room-level state machine for a live match chat panel. Combines:
//   1. REST snapshot on mount (GET /live-chat/match/:id/room)
//   2. Live WS frame stream (chat_message / chat_reaction /
//      chat_picks_update / chat_match_update / chat_viewer_count)
//   3. Optimistic action helpers (send / submitPick / react)
//
// Reaction bursts are intentionally transient — they live in their
// own short-TTL queue rather than the messages array because the
// Notion spec renders them as floating elements over the feed and
// they are not persisted server-side.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type {
  LiveChatBetPin,
  LiveChatBroadcastFrame,
  LiveChatCrowdPicks,
  LiveChatMatchSnapshot,
  LiveChatMessage,
  LiveChatRoomState,
  PickOutcome,
  ReactionKind,
} from "@oddzilla/types";
import {
  fetchRoomSnapshot,
  sendChatMessage,
  sendChatReaction,
  submitChatPick,
} from "./live-chat-client";
import { useLiveChatFrames } from "./use-live-odds";

export interface ReactionBurst {
  id: string;
  nickname: string;
  reaction: ReactionKind;
  receivedAt: number;
}

export type RoomLoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export interface UseLiveChatRoomResult {
  load: RoomLoadState;
  match: LiveChatMatchSnapshot | null;
  viewerCount: number;
  messages: LiveChatMessage[];
  myPick: PickOutcome | null;
  // null when the user has not yet voted (Notion Epic 4 reveal-on-vote
  // — the server withholds the data; the client withholds the bars).
  crowdPicks: LiveChatCrowdPicks | null;
  betPin: LiveChatBetPin | null;
  // Short-lived reaction bursts; UI fades them out and the hook
  // garbage-collects entries older than the TTL.
  bursts: ReactionBurst[];
  // Async actions. Each returns a promise that resolves to either
  // the new value or an error you can render — the hook itself
  // never throws into the React render.
  sendMessage: (text: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  submitPick: (pick: PickOutcome) => Promise<{ ok: true } | { ok: false; error: string }>;
  reactWith: (reaction: ReactionKind) => Promise<{ ok: true } | { ok: false; error: string }>;
  refresh: () => Promise<void>;
}

// Exported for unit testing. The reducer is the heart of the UI state
// machine and the only piece that's easily tested without a DOM /
// network harness.
export interface RoomState {
  match: LiveChatMatchSnapshot | null;
  viewerCount: number;
  messages: LiveChatMessage[];
  myPick: PickOutcome | null;
  crowdPicks: LiveChatCrowdPicks | null;
  betPin: LiveChatBetPin | null;
  bursts: ReactionBurst[];
}

export type Action =
  | { type: "snapshot"; snapshot: LiveChatRoomState }
  | { type: "frame"; frame: LiveChatBroadcastFrame }
  | { type: "optimistic_message"; message: LiveChatMessage }
  | {
      type: "optimistic_pick";
      pick: PickOutcome;
      crowdPicks: LiveChatCrowdPicks;
    }
  | { type: "expire_bursts"; cutoffMs: number };

// Reaction bursts auto-clear after this many ms so a stale-tab room
// doesn't accumulate them. UI fade-out target is ~1500ms; we hold
// the data slightly longer so animations can run to completion.
const BURST_TTL_MS = 2000;
// Cap message buffer — late joiners read 50 from REST, then we append
// in real time. Keep the React state shape bounded so a busy match
// with thousands of messages doesn't blow up render time.
const MAX_MESSAGES = 200;

export function initialRoomState(): RoomState {
  return {
    match: null,
    viewerCount: 0,
    messages: [],
    myPick: null,
    crowdPicks: null,
    betPin: null,
    bursts: [],
  };
}

export function roomReducer(state: RoomState, action: Action): RoomState {
  switch (action.type) {
    case "snapshot":
      return {
        match: action.snapshot.match,
        viewerCount: action.snapshot.viewerCount,
        messages: action.snapshot.messages.slice(-MAX_MESSAGES),
        myPick: action.snapshot.myPick,
        crowdPicks: action.snapshot.crowdPicks,
        betPin: action.snapshot.betPin,
        bursts: [],
      };
    case "frame":
      return applyFrame(state, action.frame);
    case "optimistic_message":
      // Avoid double-appending when the server's broadcast echoes back —
      // the message id is server-assigned, so we dedupe on it.
      if (state.messages.some((m) => m.id === action.message.id)) return state;
      return appendMessage(state, action.message);
    case "optimistic_pick":
      return {
        ...state,
        myPick: action.pick,
        crowdPicks: action.crowdPicks,
      };
    case "expire_bursts":
      return {
        ...state,
        bursts: state.bursts.filter((b) => b.receivedAt > action.cutoffMs),
      };
  }
}

function applyFrame(state: RoomState, frame: LiveChatBroadcastFrame): RoomState {
  switch (frame.type) {
    case "chat_message":
      if (state.messages.some((m) => m.id === frame.message.id)) return state;
      return appendMessage(state, frame.message);
    case "chat_reaction":
      return {
        ...state,
        bursts: [
          ...state.bursts,
          {
            id: frame.burstId,
            nickname: frame.nickname,
            reaction: frame.reaction,
            receivedAt: Date.now(),
          },
        ],
      };
    case "chat_picks_update":
      // Don't reveal the data if the viewer hasn't voted yet — the
      // server already gates new picks via the snapshot, but the
      // broadcast goes to everyone in the room, so we re-gate here.
      if (!state.myPick) return state;
      return { ...state, crowdPicks: frame.crowdPicks };
    case "chat_match_update":
      return { ...state, match: frame.match };
    case "chat_viewer_count":
      return { ...state, viewerCount: frame.viewerCount };
  }
}

function appendMessage(state: RoomState, message: LiveChatMessage): RoomState {
  const next = state.messages.concat(message);
  if (next.length > MAX_MESSAGES) next.splice(0, next.length - MAX_MESSAGES);
  return { ...state, messages: next };
}

export function useLiveChatRoom(matchId: string | null): UseLiveChatRoomResult {
  const [state, dispatch] = useReducer(roomReducer, undefined, initialRoomState);
  const [load, setLoad] = useState<RoomLoadState>({ kind: "loading" });
  // Pinned dispatch for the WS callback — useReducer's dispatch is
  // stable by React contract, but the WS frame handler closes over
  // it during subscribe, so we hold a ref to be explicit.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  // 1. Initial snapshot.
  useEffect(() => {
    if (!matchId) {
      setLoad({ kind: "error", message: "no_match_id" });
      return;
    }
    let cancelled = false;
    setLoad({ kind: "loading" });
    fetchRoomSnapshot(matchId)
      .then((snapshot) => {
        if (cancelled) return;
        dispatchRef.current({ type: "snapshot", snapshot });
        setLoad({ kind: "ready" });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setLoad({ kind: "error", message: err.message ?? "fetch_failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  // 2. Live frames.
  useLiveChatFrames(matchId, (frame) => {
    dispatchRef.current({ type: "frame", frame });
  });

  // 3. Reaction burst GC.
  useEffect(() => {
    if (state.bursts.length === 0) return;
    const t = setTimeout(() => {
      dispatchRef.current({
        type: "expire_bursts",
        cutoffMs: Date.now() - BURST_TTL_MS,
      });
    }, 250);
    return () => clearTimeout(t);
  }, [state.bursts]);

  // 4. Actions. Each catches its own error so the UI can render an
  // inline message without React error boundaries firing.
  const sendMessage = useCallback(
    async (text: string) => {
      if (!matchId) return { ok: false as const, error: "no_match_id" };
      try {
        const message = await sendChatMessage(matchId, text);
        dispatchRef.current({ type: "optimistic_message", message });
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    },
    [matchId],
  );

  const submitPick = useCallback(
    async (pick: PickOutcome) => {
      if (!matchId) return { ok: false as const, error: "no_match_id" };
      try {
        const res = await submitChatPick(matchId, pick);
        dispatchRef.current({
          type: "optimistic_pick",
          pick: res.myPick,
          crowdPicks: res.crowdPicks,
        });
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    },
    [matchId],
  );

  const reactWith = useCallback(
    async (reaction: ReactionKind) => {
      if (!matchId) return { ok: false as const, error: "no_match_id" };
      try {
        await sendChatReaction(matchId, reaction);
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    },
    [matchId],
  );

  const refresh = useCallback(async () => {
    if (!matchId) return;
    try {
      const snapshot = await fetchRoomSnapshot(matchId);
      dispatchRef.current({ type: "snapshot", snapshot });
      setLoad({ kind: "ready" });
    } catch (err) {
      setLoad({ kind: "error", message: (err as Error).message });
    }
  }, [matchId]);

  return {
    load,
    match: state.match,
    viewerCount: state.viewerCount,
    messages: state.messages,
    myPick: state.myPick,
    crowdPicks: state.crowdPicks,
    betPin: state.betPin,
    bursts: state.bursts,
    sendMessage,
    submitPick,
    reactWith,
    refresh,
  };
}
