"use client";

// React hook for live odds + live scores + live chat. Wraps a single
// shared WebSocket connection so multiple components on one page
// don't each open their own socket.
//
// Usage:
//   const odds   = useLiveOdds(matchId);
//   odds[`${marketId}:${outcomeId}`]?.publishedOdds  // latest tick
//
//   const score  = useLiveScore(matchId);
//   score?.home  // latest scoreboard from feed-ingester
//
//   useLiveChatFrames(matchId, (frame) => { ... })
//   // chat_message | chat_reaction | chat_picks_update |
//   // chat_match_update | chat_viewer_count frames from services/api
//
// Reconnect logic: exponential backoff on close (1s → 16s cap). On each
// successful reconnect the hook resubscribes everything (odds + chat).

import { useEffect, useRef, useState } from "react";

import { openSocket } from "./ws-client";
import type { LiveScore } from "./live-score";
import type { LiveChatBroadcastFrame } from "@oddzilla/types";

export interface LiveOddsTick {
  marketId: string;
  outcomeId: string;
  publishedOdds: string;
  // Implied probability — present when odds-publisher carried it through
  // (it does for every Oddin-priced outcome). Required so the bet slip
  // can refresh its tiple/tippot quote when odds drift.
  probability?: string;
  active: boolean;
  ts: string; // ISO
}

export interface TicketFrame {
  type: "ticket";
  ticketId: string;
  status:
    | "pending_delay"
    | "accepted"
    | "rejected"
    | "settled"
    | "voided"
    | "cashed_out";
  rejectReason?: string | null;
  actualPayoutMicro?: string | null;
}

type TicketListener = (frame: TicketFrame) => void;

type ChatFrameListener = (frame: LiveChatBroadcastFrame) => void;

interface SharedConnection {
  socket: WebSocket | null;
  opening: boolean;
  subscriptionCounts: Map<string, number>;
  // Chat fan-out runs in its own dimension on the same socket — see
  // services/ws-gateway/src/server.ts and packages/types/src/ws.ts
  // (the `chat` flag on subscribe/unsubscribe targets the chat
  // dimension independently of the odds dimension).
  chatSubscriptionCounts: Map<string, number>;
  listeners: Map<string, { matchIds: Set<string>; onTick: (tick: LiveOddsTick) => void }>;
  scoreListeners: Map<
    string,
    { matchIds: Set<string>; onScore: (matchId: string, score: LiveScore) => void }
  >;
  chatListeners: Map<
    string,
    { matchIds: Set<string>; onFrame: ChatFrameListener }
  >;
  ticketListeners: Set<TicketListener>;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  // Bumped on every "open" event and decremented on close. UI uses
  // this so the "Reconnecting…" banner reflects the real socket
  // state without each component running its own WS instance.
  connectionGeneration: number;
  // True between socket open and close (or absence). Components read
  // this through useWsConnected() — it's the single source of truth
  // for the reconnect banner.
  connected: boolean;
  // Listeners notified whenever `connected` flips so React state can
  // catch up without us polling.
  connectionListeners: Set<() => void>;
}

let shared: SharedConnection | null = null;

export function getShared(): SharedConnection {
  if (!shared) {
    shared = {
      socket: null,
      opening: false,
      subscriptionCounts: new Map(),
      chatSubscriptionCounts: new Map(),
      listeners: new Map(),
      scoreListeners: new Map(),
      chatListeners: new Map(),
      ticketListeners: new Set(),
      reconnectAttempts: 0,
      reconnectTimer: null,
      connectionGeneration: 0,
      connected: false,
      connectionListeners: new Set(),
    };
  }
  return shared;
}

function setConnected(conn: SharedConnection, value: boolean): void {
  if (conn.connected === value) return;
  conn.connected = value;
  for (const listener of conn.connectionListeners) {
    try {
      listener();
    } catch {
      // never let a misbehaving listener block the others
    }
  }
}

export function ensureSharedConnection(): void {
  const conn = getShared();
  ensureConnected(conn);
}

function ensureConnected(conn: SharedConnection) {
  if (conn.socket && conn.socket.readyState === WebSocket.OPEN) return;
  if (conn.socket && conn.socket.readyState === WebSocket.CONNECTING) return;
  if (conn.opening) return;

  conn.opening = true;
  // openSocket() resolves the URL from window.location when
  // NEXT_PUBLIC_WS_URL is empty — matches the ws-client.ts pattern and
  // avoids baking `ws://localhost:3002` into the prod bundle.
  const ws = openSocket("/ws");
  conn.socket = ws;

  ws.addEventListener("open", () => {
    conn.opening = false;
    conn.reconnectAttempts = 0;
    conn.connectionGeneration += 1;
    setConnected(conn, true);
    // Resubscribe everything we think we want — both dimensions.
    const odds = Array.from(conn.subscriptionCounts.keys());
    if (odds.length > 0) {
      ws.send(JSON.stringify({ type: "subscribe", matchIds: odds }));
    }
    const chats = Array.from(conn.chatSubscriptionCounts.keys());
    if (chats.length > 0) {
      ws.send(
        JSON.stringify({ type: "subscribe", matchIds: chats, chat: true }),
      );
    }
  });

  ws.addEventListener("message", (ev) => {
    try {
      // Union of frame shapes; narrow on `type` below.
      const payload = JSON.parse(ev.data as string) as {
        type: string;
        matchId?: string;
        marketId?: string;
        outcomeId?: string;
        publishedOdds?: string;
        probability?: string;
        active?: boolean;
        ts?: string;
        liveScore?: LiveScore;
        ticketId?: string;
        status?: TicketFrame["status"];
        rejectReason?: string | null;
        actualPayoutMicro?: string | null;
      };
      if (payload.type === "odds") {
        const { matchId, marketId, outcomeId, publishedOdds, probability, active, ts } = payload;
        if (!matchId || !marketId || !outcomeId || !publishedOdds || !ts) return;
        const tick: LiveOddsTick = {
          marketId,
          outcomeId,
          publishedOdds,
          probability: probability && probability !== "" ? probability : undefined,
          active: active ?? true,
          ts,
        };
        for (const { matchIds, onTick } of conn.listeners.values()) {
          if (matchIds.has(matchId)) onTick(tick);
        }
        return;
      }
      if (payload.type === "score") {
        const { matchId, liveScore } = payload;
        if (!matchId || !liveScore) return;
        for (const { matchIds, onScore } of conn.scoreListeners.values()) {
          if (matchIds.has(matchId)) onScore(matchId, liveScore);
        }
        return;
      }
      if (payload.type === "ticket" && payload.ticketId && payload.status) {
        const frame: TicketFrame = {
          type: "ticket",
          ticketId: payload.ticketId,
          status: payload.status as TicketFrame["status"],
          rejectReason: payload.rejectReason ?? null,
          actualPayoutMicro: payload.actualPayoutMicro ?? null,
        };
        for (const listener of conn.ticketListeners) listener(frame);
        return;
      }
      // Chat fan-out frames. The matchId is always present (the
      // server-side publishers stamp it before publish) so we route
      // by it directly to interested listeners.
      if (
        typeof payload.type === "string" &&
        payload.type.startsWith("chat_") &&
        typeof payload.matchId === "string"
      ) {
        const chatFrame = payload as unknown as LiveChatBroadcastFrame;
        for (const { matchIds, onFrame } of conn.chatListeners.values()) {
          if (matchIds.has(chatFrame.matchId)) onFrame(chatFrame);
        }
        return;
      }
    } catch {
      // ignore malformed frames
    }
  });

  ws.addEventListener("close", () => {
    conn.opening = false;
    conn.socket = null;
    setConnected(conn, false);
    const hasSubscribers =
      conn.subscriptionCounts.size > 0 ||
      conn.chatSubscriptionCounts.size > 0 ||
      conn.ticketListeners.size > 0;
    if (!hasSubscribers) return;

    // Exponential backoff with full jitter so a synchronised reconnect
    // storm (Caddy restart, network blip) doesn't all hit ws-gateway at
    // exactly the same instant. Without jitter, every browser
    // recomputes the same `1000 * 2 ** N` delay and stampedes — which
    // is exactly what triggers the MAX_CLIENTS=503 rejection on the
    // server side.
    const cap = Math.min(16_000, 1000 * 2 ** conn.reconnectAttempts);
    const delay = Math.floor(cap * (0.5 + Math.random() * 0.5));
    conn.reconnectAttempts += 1;
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = setTimeout(() => ensureConnected(conn), delay);
  });

  ws.addEventListener("error", () => {
    // close will also fire; let the close handler drive reconnect
  });
}

function bumpSubscription(conn: SharedConnection, matchId: string, delta: number) {
  const current = conn.subscriptionCounts.get(matchId) ?? 0;
  const next = current + delta;
  if (next <= 0) {
    conn.subscriptionCounts.delete(matchId);
    if (conn.socket && conn.socket.readyState === WebSocket.OPEN) {
      conn.socket.send(JSON.stringify({ type: "unsubscribe", matchIds: [matchId] }));
    }
  } else {
    conn.subscriptionCounts.set(matchId, next);
    if (current === 0 && conn.socket && conn.socket.readyState === WebSocket.OPEN) {
      conn.socket.send(JSON.stringify({ type: "subscribe", matchIds: [matchId] }));
    }
  }
}

function bumpChatSubscription(
  conn: SharedConnection,
  matchId: string,
  delta: number,
) {
  const current = conn.chatSubscriptionCounts.get(matchId) ?? 0;
  const next = current + delta;
  if (next <= 0) {
    conn.chatSubscriptionCounts.delete(matchId);
    if (conn.socket && conn.socket.readyState === WebSocket.OPEN) {
      conn.socket.send(
        JSON.stringify({
          type: "unsubscribe",
          matchIds: [matchId],
          chat: true,
        }),
      );
    }
  } else {
    conn.chatSubscriptionCounts.set(matchId, next);
    if (current === 0 && conn.socket && conn.socket.readyState === WebSocket.OPEN) {
      conn.socket.send(
        JSON.stringify({
          type: "subscribe",
          matchIds: [matchId],
          chat: true,
        }),
      );
    }
  }
}

export function useLiveOdds(matchId: string | null): Record<string, LiveOddsTick> {
  const [ticks, setTicks] = useState<Record<string, LiveOddsTick>>({});

  useEffect(() => {
    if (!matchId) return;
    const conn = getShared();

    const id = crypto.randomUUID();
    conn.listeners.set(id, {
      matchIds: new Set([matchId]),
      onTick: (tick) => {
        setTicks((prev) => {
          const key = `${tick.marketId}:${tick.outcomeId}`;
          const existing = prev[key];
          // Drop out-of-order frames.
          if (existing && new Date(existing.ts) > new Date(tick.ts)) return prev;
          return { ...prev, [key]: tick };
        });
      },
    });
    bumpSubscription(conn, matchId, 1);
    ensureConnected(conn);

    return () => {
      conn.listeners.delete(id);
      bumpSubscription(conn, matchId, -1);
    };
  }, [matchId]);

  return ticks;
}

// Multi-match variant for components that watch a heterogeneous selection
// set (the bet slip). Returns ticks keyed by `${marketId}:${outcomeId}` —
// market ids are unique across matches, so collisions can't occur.
export function useLiveOddsForMatches(
  matchIds: readonly string[],
): Record<string, LiveOddsTick> {
  const [ticks, setTicks] = useState<Record<string, LiveOddsTick>>({});

  // Stable join key — we only resubscribe when the *set* of matches
  // changes, not on every render's array identity churn. Sort + join
  // produces a deterministic string; the effect derives the actual
  // match ids from it so the deps array is honestly just `[key]`
  // (no eslint-disable needed).
  const key = [...matchIds].sort().join(",");

  useEffect(() => {
    if (key === "") return;
    const conn = getShared();
    const matchIdSet = new Set(key.split(","));

    const id = crypto.randomUUID();
    conn.listeners.set(id, {
      matchIds: matchIdSet,
      onTick: (tick) => {
        setTicks((prev) => {
          const k = `${tick.marketId}:${tick.outcomeId}`;
          const existing = prev[k];
          if (existing && new Date(existing.ts) > new Date(tick.ts)) return prev;
          return { ...prev, [k]: tick };
        });
      },
    });
    for (const m of matchIdSet) bumpSubscription(conn, m, 1);
    ensureConnected(conn);

    return () => {
      conn.listeners.delete(id);
      for (const m of matchIdSet) bumpSubscription(conn, m, -1);
    };
  }, [key]);

  return ticks;
}

// Live scoreboard for a single match. Returns `null` until the first
// `score` frame lands; consumers should fall back to the SSR-baked
// liveScore in the meantime. Subscribes the same matchId on the
// shared connection — so a component using both `useLiveOdds` and
// `useLiveScore` for the same match is one physical subscription.
export function useLiveScore(matchId: string | null): LiveScore | null {
  const [score, setScore] = useState<LiveScore | null>(null);

  useEffect(() => {
    if (!matchId) return;
    const conn = getShared();

    const id = crypto.randomUUID();
    conn.scoreListeners.set(id, {
      matchIds: new Set([matchId]),
      onScore: (_mid, fresh) => setScore(fresh),
    });
    bumpSubscription(conn, matchId, 1);
    ensureConnected(conn);

    return () => {
      conn.scoreListeners.delete(id);
      bumpSubscription(conn, matchId, -1);
    };
  }, [matchId]);

  return score;
}

// Subscribe to live chat broadcast frames for one match. The callback
// receives every chat_* frame the server publishes
// (LiveChatBroadcastFrame). State management — turning a stream of
// frames into a coherent room snapshot — lives in
// use-live-chat-room.ts, NOT here; this hook is the thin transport.
export function useLiveChatFrames(
  matchId: string | null,
  onFrame: ChatFrameListener,
): void {
  // Pin the latest callback so listeners we register synchronously
  // call into the freshest closure without resubscribing on every
  // render.
  const cbRef = useRef(onFrame);
  cbRef.current = onFrame;

  useEffect(() => {
    if (!matchId) return;
    const conn = getShared();

    const id = crypto.randomUUID();
    conn.chatListeners.set(id, {
      matchIds: new Set([matchId]),
      onFrame: (frame) => {
        cbRef.current(frame);
      },
    });
    bumpChatSubscription(conn, matchId, 1);
    ensureConnected(conn);

    return () => {
      conn.chatListeners.delete(id);
      bumpChatSubscription(conn, matchId, -1);
    };
  }, [matchId]);
}

// Boolean view on the shared socket. Drives the "Reconnecting…"
// banner per Notion Epic 6 — the moment the close handler fires
// every component using this hook re-renders with `false`, the next
// open flips it back to `true`.
export function useWsConnected(): boolean {
  const conn = getShared();
  const [connected, setConnectedState] = useState(conn.connected);
  useEffect(() => {
    const listener = () => setConnectedState(getShared().connected);
    const c = getShared();
    c.connectionListeners.add(listener);
    // Sync once on mount in case the state changed before the effect
    // ran (e.g. between render and commit).
    setConnectedState(c.connected);
    return () => {
      c.connectionListeners.delete(listener);
    };
  }, []);
  return connected;
}

// Multi-match scoreboard subscription, keyed by matchId. Mirrors
// useLiveOddsForMatches — used by the storefront list pages so every
// visible row gets its scoreboard repriced live without each row
// opening its own subscription.
export function useLiveScoresForMatches(
  matchIds: readonly string[],
): Record<string, LiveScore> {
  const [scores, setScores] = useState<Record<string, LiveScore>>({});

  const key = [...matchIds].sort().join(",");

  useEffect(() => {
    if (key === "") return;
    const conn = getShared();
    const matchIdSet = new Set(key.split(","));

    const id = crypto.randomUUID();
    conn.scoreListeners.set(id, {
      matchIds: matchIdSet,
      onScore: (mid, fresh) => {
        setScores((prev) => ({ ...prev, [mid]: fresh }));
      },
    });
    for (const m of matchIdSet) bumpSubscription(conn, m, 1);
    ensureConnected(conn);

    return () => {
      conn.scoreListeners.delete(id);
      for (const m of matchIdSet) bumpSubscription(conn, m, -1);
    };
  }, [key]);

  return scores;
}
