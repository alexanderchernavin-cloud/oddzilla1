"use client";

// React hook for live odds. Wraps a single shared WebSocket connection
// so multiple components on one page don't each open their own socket.
//
// Usage:
//   const odds = useLiveOdds(matchId);
//   odds[`${marketId}:${outcomeId}`]?.publishedOdds  // latest tick
//
// Reconnect logic: exponential backoff on close (1s → 16s cap). On each
// successful reconnect the hook resubscribes automatically.

import { useEffect, useRef, useState } from "react";

export interface LiveOddsTick {
  marketId: string;
  outcomeId: string;
  publishedOdds: string;
  active: boolean;
  ts: string; // ISO
}

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:3002";

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

interface SharedConnection {
  socket: WebSocket | null;
  opening: boolean;
  subscriptionCounts: Map<string, number>;
  listeners: Map<string, { matchIds: Set<string>; onTick: (tick: LiveOddsTick) => void }>;
  ticketListeners: Set<TicketListener>;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

let shared: SharedConnection | null = null;

export function getShared(): SharedConnection {
  if (!shared) {
    shared = {
      socket: null,
      opening: false,
      subscriptionCounts: new Map(),
      listeners: new Map(),
      ticketListeners: new Set(),
      reconnectAttempts: 0,
      reconnectTimer: null,
    };
  }
  return shared;
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
  const ws = new WebSocket(`${WS_URL}/ws`);
  conn.socket = ws;

  ws.addEventListener("open", () => {
    conn.opening = false;
    conn.reconnectAttempts = 0;
    // Resubscribe everything we think we want.
    const all = Array.from(conn.subscriptionCounts.keys());
    if (all.length > 0) {
      ws.send(JSON.stringify({ type: "subscribe", matchIds: all }));
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
        active?: boolean;
        ts?: string;
        ticketId?: string;
        status?: TicketFrame["status"];
        rejectReason?: string | null;
        actualPayoutMicro?: string | null;
      };
      if (payload.type === "odds") {
        const { matchId, marketId, outcomeId, publishedOdds, active, ts } = payload;
        if (!matchId || !marketId || !outcomeId || !publishedOdds || !ts) return;
        const tick: LiveOddsTick = {
          marketId,
          outcomeId,
          publishedOdds,
          active: active ?? true,
          ts,
        };
        for (const { matchIds, onTick } of conn.listeners.values()) {
          if (matchIds.has(matchId)) onTick(tick);
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
    } catch {
      // ignore malformed frames
    }
  });

  ws.addEventListener("close", () => {
    conn.opening = false;
    conn.socket = null;
    const hasSubscribers =
      conn.subscriptionCounts.size > 0 || conn.ticketListeners.size > 0;
    if (!hasSubscribers) return;

    const delay = Math.min(16_000, 1000 * 2 ** conn.reconnectAttempts);
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

export function useLiveOdds(matchId: string | null): Record<string, LiveOddsTick> {
  const [ticks, setTicks] = useState<Record<string, LiveOddsTick>>({});
  const listenerIdRef = useRef<string>("");

  useEffect(() => {
    if (!matchId) return;
    const conn = getShared();

    const id = crypto.randomUUID();
    listenerIdRef.current = id;
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
