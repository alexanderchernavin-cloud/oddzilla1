"use client";

// React hook for live odds + live scores. Wraps a single shared
// WebSocket connection so multiple components on one page don't each
// open their own socket.
//
// Usage:
//   const odds   = useLiveOdds(matchId);
//   odds[`${marketId}:${outcomeId}`]?.publishedOdds  // latest tick
//
//   const score  = useLiveScore(matchId);
//   score?.home  // latest scoreboard from feed-ingester
//
// Reconnect logic: exponential backoff on close (1s → 16s cap). On each
// successful reconnect the hook resubscribes everything.

import { useEffect, useState } from "react";

import { openSocket } from "./ws-client";
import type { LiveScore } from "./live-score";
import { observeServerTime } from "./running-clock";
import type { SupportMessageFrame } from "@oddzilla/types";

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

// Market-level status tick. Published by feed-ingester (every
// odds_change with a status transition, bet_stop blanket,
// suspend-before-recover flush) and by settlement (settle → -3,
// cancel → -4, rollbacks). The storefront merges these into its
// rendered market.status so the `isMarketBettable` predicate can lock
// terminal statuses immediately and unlock on Oddin reactivation —
// without it, a market settled mid-session keeps showing its last
// outcome prices and placement rejects with `market_not_active`.
//
// Status codes mirror `markets.status` smallint:
//   1 active, 0 deactivated, -1 suspended, -2 handover,
//   -3 settled, -4 cancelled.
export interface LiveMarketStatusTick {
  marketId: string;
  status: number;
  ts: string; // ISO
}

// Match-level lifecycle tick. Published by feed-ingester whenever
// matches.status transitions (every odds_change ships <sport_event_status>
// — `not_started → live → closed/cancelled`) and by settlement when
// the all-markets-terminal predicate flips a match closed (Oddin
// sometimes drops the final `<sport_event_status status="4">` once
// the last market settles). The storefront uses this to drop the
// LIVE pill the moment a match finishes — without it, match.status
// stays frozen at whatever SSR captured and the indicator only
// refreshes on a hard reload.
//
// `status` mirrors the normalized `matches.status` enum:
//   'not_started' | 'live' | 'closed' | 'cancelled' | 'suspended'
export interface LiveMatchStatusTick {
  status: "not_started" | "live" | "closed" | "cancelled" | "suspended";
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

type SupportFrameListener = (frame: SupportMessageFrame) => void;

interface SharedConnection {
  socket: WebSocket | null;
  opening: boolean;
  subscriptionCounts: Map<string, number>;
  listeners: Map<string, { matchIds: Set<string>; onTick: (tick: LiveOddsTick) => void }>;
  // Per-market status listeners. Same shared connection as odds —
  // server fans out `marketStatus` frames on the same `odds:match:{id}`
  // channel, ws-gateway forwards them as-is, and we dispatch by `type`.
  marketStatusListeners: Map<
    string,
    {
      matchIds: Set<string>;
      onStatus: (matchId: string, tick: LiveMarketStatusTick) => void;
    }
  >;
  // Match-level lifecycle listeners. Same shared socket / same
  // odds:match:{id} Redis channel — the gateway forwards every
  // matchStatus frame verbatim and we dispatch by JSON `type`.
  matchStatusListeners: Map<
    string,
    {
      matchIds: Set<string>;
      onStatus: (matchId: string, tick: LiveMatchStatusTick) => void;
    }
  >;
  scoreListeners: Map<
    string,
    { matchIds: Set<string>; onScore: (matchId: string, score: LiveScore) => void }
  >;
  ticketListeners: Set<TicketListener>;
  // Live support-chat frames pushed on the same user:{id} Redis channel
  // as ticket frames. The floating widget registers one listener; the
  // gateway forwards the JSON verbatim, we route by `type` field below.
  supportListeners: Set<SupportFrameListener>;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  // Bumped on every "open" event. Lets a consumer tell one socket
  // lifetime from the next without running its own WS instance.
  connectionGeneration: number;
  // True between socket open and close (or absence). Components read
  // this through useWsConnected() — it's the single source of truth
  // for a reconnect indicator.
  connected: boolean;
  // Listeners notified whenever `connected` flips so React state can
  // catch up without us polling.
  connectionListeners: Set<() => void>;
  // ── Session identity of the socket ────────────────────────────────
  // ws-gateway authenticates ONCE, from the `oddzilla_access` cookie
  // present on the HTTP upgrade, and never re-reads it. A socket opened
  // while logged out is anonymous for its entire life: it receives
  // public odds but is never subscribed to the private `user:{id}`
  // channel that carries ticket frames. Signing in is a client-side
  // route change (login-form.tsx does router.push, not a reload), so
  // without this reconciliation the pre-login socket survives the login
  // and the bettor places a live bet whose acceptance frame can never
  // arrive — the bet slip then sits on "Placing…" until its timeout,
  // and does not clear, inviting a duplicate placement.
  //
  // `helloUserId` is what the gateway said this socket is (from the
  // `hello` frame); `expectedUserId` is what the app knows the session
  // to be (SSR-resolved, published via setExpectedSessionUser). A
  // mismatch means the socket's identity is stale — reconnect so the
  // upgrade re-reads the current cookie.
  helloUserId: string | null;
  helloSeen: boolean;
  expectedUserId: string | null;
  expectedUserKnown: boolean;
  // Bounded so a genuinely expired access cookie can't spin: after
  // MAX_AUTH_RECONNECTS the socket is left as-is and the UI falls back
  // to polling (bet-slip-rail.tsx polls GET /bets/:id through the
  // delay window for exactly this reason).
  authReconnects: number;
}

// Two attempts covers the case this exists for — a socket opened before
// login, reconnecting once with the fresh cookie. Beyond that the cookie
// itself is the problem (expired access token; only a navigation through
// the Next.js middleware refreshes it) and retrying just burns upgrades.
const MAX_AUTH_RECONNECTS = 2;

let shared: SharedConnection | null = null;

export function getShared(): SharedConnection {
  if (!shared) {
    shared = {
      socket: null,
      opening: false,
      subscriptionCounts: new Map(),
      listeners: new Map(),
      marketStatusListeners: new Map(),
      matchStatusListeners: new Map(),
      scoreListeners: new Map(),
      ticketListeners: new Set(),
      supportListeners: new Set(),
      reconnectAttempts: 0,
      reconnectTimer: null,
      connectionGeneration: 0,
      connected: false,
      connectionListeners: new Set(),
      helloUserId: null,
      helloSeen: false,
      expectedUserId: null,
      expectedUserKnown: false,
      authReconnects: 0,
    };
  }
  return shared;
}

// Publish the SSR-resolved session identity to the shared socket. Called
// from <WsSessionSync /> in the (main) layout on mount and on every
// change (login, logout, account switch). Reconnects the socket when its
// authenticated identity no longer matches the session's.
export function setExpectedSessionUser(userId: string | null): void {
  const conn = getShared();
  if (conn.expectedUserKnown && conn.expectedUserId === userId) return;
  conn.expectedUserId = userId;
  conn.expectedUserKnown = true;
  // A real session change earns a fresh retry budget — the previous
  // budget may have been spent reconciling the previous identity.
  conn.authReconnects = 0;
  reconcileSocketIdentity(conn);
}

// Close the socket when the gateway's view of who it is disagrees with
// the app's. The close handler's existing backoff reconnects, and that
// upgrade carries whatever cookie the browser holds now.
function reconcileSocketIdentity(conn: SharedConnection): void {
  if (!conn.helloSeen || !conn.expectedUserKnown) return;
  if (conn.helloUserId === conn.expectedUserId) {
    conn.authReconnects = 0;
    return;
  }
  if (conn.authReconnects >= MAX_AUTH_RECONNECTS) return;
  conn.authReconnects += 1;
  // Mark stale immediately: the close event is async and another hello
  // can't arrive before it, but a second reconcile call could.
  conn.helloSeen = false;
  conn.socket?.close();
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
    // Resubscribe everything we think we want.
    const odds = Array.from(conn.subscriptionCounts.keys());
    if (odds.length > 0) {
      ws.send(JSON.stringify({ type: "subscribe", matchIds: odds }));
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
        ts?: string | number;
        liveScore?: LiveScore;
        ticketId?: string;
        // `status` is overloaded across frame kinds:
        //   - ticket frames:    TicketFrame["status"] (string)
        //   - marketStatus:     number (markets.status smallint)
        //   - matchStatus:      LiveMatchStatusTick["status"] (string)
        // Narrowed at the dispatch site by frame `type`.
        status?: TicketFrame["status"] | LiveMatchStatusTick["status"] | number;
        rejectReason?: string | null;
        actualPayoutMicro?: string | null;
        // `hello` only — the identity ws-gateway authenticated this
        // socket as, or null for an anonymous upgrade.
        userId?: string | null;
      };
      // Every stamped frame is an observation of the server's clock
      // against this device's, feeding the estimate the running match
      // clocks are read against (see createServerClock). Odds and status
      // ticks carry `ts` from odds-publisher; score frames carry the
      // ingester's `updatedAt`. Anything unparseable is simply not an
      // observation.
      if (typeof payload.ts === "number") {
        observeServerTime(payload.ts);
      } else if (typeof payload.ts === "string") {
        observeServerTime(Date.parse(payload.ts));
      }
      if (typeof payload.liveScore?.updatedAt === "string") {
        observeServerTime(Date.parse(payload.liveScore.updatedAt));
      }
      // First frame on every connection. Carries the identity the
      // gateway resolved from the upgrade's cookie; reconcile it
      // against the session the app believes it has.
      if (payload.type === "hello") {
        conn.helloUserId = payload.userId ?? null;
        conn.helloSeen = true;
        reconcileSocketIdentity(conn);
        return;
      }
      if (payload.type === "odds") {
        const { matchId, marketId, outcomeId, publishedOdds, probability, active, ts } = payload;
        if (!matchId || !marketId || !outcomeId || !publishedOdds || ts == null) return;
        const tsStr = typeof ts === "number" ? new Date(ts).toISOString() : ts;
        const tick: LiveOddsTick = {
          marketId,
          outcomeId,
          publishedOdds,
          probability: probability && probability !== "" ? probability : undefined,
          active: active ?? true,
          ts: tsStr,
        };
        for (const { matchIds, onTick } of conn.listeners.values()) {
          if (matchIds.has(matchId)) onTick(tick);
        }
        return;
      }
      if (payload.type === "marketStatus") {
        const { matchId, marketId, status, ts } = payload;
        if (
          !matchId ||
          !marketId ||
          typeof status !== "number" ||
          ts == null
        )
          return;
        const tsStr = typeof ts === "number" ? new Date(ts).toISOString() : ts;
        const tick: LiveMarketStatusTick = { marketId, status, ts: tsStr };
        for (const { matchIds, onStatus } of conn.marketStatusListeners.values()) {
          if (matchIds.has(matchId)) onStatus(matchId, tick);
        }
        return;
      }
      if (payload.type === "matchStatus") {
        const { matchId, status, ts } = payload;
        if (!matchId || typeof status !== "string" || ts == null) return;
        // Tight allow-list for the rendered status enum — anything off
        // the list is dropped rather than poisoning React state with an
        // unknown string we don't have UI for.
        if (
          status !== "not_started" &&
          status !== "live" &&
          status !== "closed" &&
          status !== "cancelled" &&
          status !== "suspended"
        ) {
          return;
        }
        const tsStr = typeof ts === "number" ? new Date(ts).toISOString() : ts;
        const tick: LiveMatchStatusTick = {
          status,
          ts: tsStr,
        };
        for (const { matchIds, onStatus } of conn.matchStatusListeners.values()) {
          if (matchIds.has(matchId)) onStatus(matchId, tick);
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
      // Live support chat — admin replies (and the bettor's own posts
      // from other tabs) ride here. The api publishes the entire
      // SupportMessageFrame shape on `user:{userId}`; ws-gateway
      // forwards verbatim and we dispatch by `type`.
      if (payload.type === "support_message") {
        const frame = payload as unknown as SupportMessageFrame;
        if (!frame.threadId || !frame.message) return;
        for (const listener of conn.supportListeners) listener(frame);
        return;
      }
    } catch {
      // ignore malformed frames
    }
  });

  ws.addEventListener("close", () => {
    conn.opening = false;
    conn.socket = null;
    // The next connection re-authenticates from scratch; until its
    // hello lands we know nothing about the new socket's identity.
    conn.helloSeen = false;
    conn.helloUserId = null;
    setConnected(conn, false);
    const hasSubscribers =
      conn.subscriptionCounts.size > 0 ||
      conn.ticketListeners.size > 0 ||
      conn.supportListeners.size > 0;
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

// Live market-level status for one match, keyed by marketId. Returns
// only the deltas we've seen — consumers should fall back to the SSR
// snapshot's `m.status` for markets that haven't ticked yet. Used by
// `live-markets.tsx` to lock placement on terminal statuses
// (settled / cancelled / deactivated) immediately on settle, without
// waiting for an outcome tick that may never arrive.
export function useLiveMarketStatus(
  matchId: string | null,
): Record<string, LiveMarketStatusTick> {
  const [statuses, setStatuses] = useState<Record<string, LiveMarketStatusTick>>(
    {},
  );

  useEffect(() => {
    if (!matchId) return;
    const conn = getShared();

    const id = crypto.randomUUID();
    conn.marketStatusListeners.set(id, {
      matchIds: new Set([matchId]),
      onStatus: (_mid, tick) => {
        setStatuses((prev) => {
          const existing = prev[tick.marketId];
          // Drop out-of-order frames.
          if (existing && new Date(existing.ts) > new Date(tick.ts)) return prev;
          return { ...prev, [tick.marketId]: tick };
        });
      },
    });
    bumpSubscription(conn, matchId, 1);
    ensureConnected(conn);

    return () => {
      conn.marketStatusListeners.delete(id);
      bumpSubscription(conn, matchId, -1);
    };
  }, [matchId]);

  return statuses;
}

// Multi-match variant for the bet-slip rail — selections can span
// matches, so we need market-status visibility across the slip's full
// match set without each leg opening its own subscription. Keyed by
// marketId (globally unique across matches).
export function useLiveMarketStatusForMatches(
  matchIds: readonly string[],
): Record<string, LiveMarketStatusTick> {
  const [statuses, setStatuses] = useState<Record<string, LiveMarketStatusTick>>(
    {},
  );

  const key = [...matchIds].sort().join(",");

  useEffect(() => {
    if (key === "") return;
    const conn = getShared();
    const matchIdSet = new Set(key.split(","));

    const id = crypto.randomUUID();
    conn.marketStatusListeners.set(id, {
      matchIds: matchIdSet,
      onStatus: (_mid, tick) => {
        setStatuses((prev) => {
          const existing = prev[tick.marketId];
          if (existing && new Date(existing.ts) > new Date(tick.ts)) return prev;
          return { ...prev, [tick.marketId]: tick };
        });
      },
    });
    for (const m of matchIdSet) bumpSubscription(conn, m, 1);
    ensureConnected(conn);

    return () => {
      conn.marketStatusListeners.delete(id);
      for (const m of matchIdSet) bumpSubscription(conn, m, -1);
    };
  }, [key]);

  return statuses;
}

// Live match-level lifecycle for one match. Returns `null` until the
// first `matchStatus` frame lands; callers fall back to the SSR
// snapshot's `match.status`. The hook subscribes on the same shared
// connection so a component using `useLiveOdds` and
// `useLiveMatchStatus` for the same match is one physical
// subscription.
export function useLiveMatchStatus(
  matchId: string | null,
): LiveMatchStatusTick | null {
  const [tick, setTick] = useState<LiveMatchStatusTick | null>(null);

  useEffect(() => {
    if (!matchId) return;
    const conn = getShared();

    const id = crypto.randomUUID();
    conn.matchStatusListeners.set(id, {
      matchIds: new Set([matchId]),
      onStatus: (_mid, fresh) => {
        setTick((prev) => {
          // Drop out-of-order frames so a late-arriving live tick can't
          // overwrite a fresher closed tick.
          if (prev && new Date(prev.ts) > new Date(fresh.ts)) return prev;
          return fresh;
        });
      },
    });
    bumpSubscription(conn, matchId, 1);
    ensureConnected(conn);

    return () => {
      conn.matchStatusListeners.delete(id);
      bumpSubscription(conn, matchId, -1);
    };
  }, [matchId]);

  return tick;
}

// Multi-match variant of useLiveMatchStatus — list pages (lobby,
// /live, /upcoming, /sport/[slug]) use this to drop the LIVE pill on
// any visible match the moment Oddin reports it closed. Keyed by
// matchId; entries appear only after a tick arrives, so consumers
// should default to the SSR-baked status for matches that haven't
// transitioned during the page's lifetime.
export function useLiveMatchStatusForMatches(
  matchIds: readonly string[],
): Record<string, LiveMatchStatusTick> {
  const [statuses, setStatuses] = useState<Record<string, LiveMatchStatusTick>>(
    {},
  );

  const key = [...matchIds].sort().join(",");

  useEffect(() => {
    if (key === "") return;
    const conn = getShared();
    const matchIdSet = new Set(key.split(","));

    const id = crypto.randomUUID();
    conn.matchStatusListeners.set(id, {
      matchIds: matchIdSet,
      onStatus: (mid, fresh) => {
        setStatuses((prev) => {
          const existing = prev[mid];
          if (existing && new Date(existing.ts) > new Date(fresh.ts)) return prev;
          return { ...prev, [mid]: fresh };
        });
      },
    });
    for (const m of matchIdSet) bumpSubscription(conn, m, 1);
    ensureConnected(conn);

    return () => {
      conn.matchStatusListeners.delete(id);
      for (const m of matchIdSet) bumpSubscription(conn, m, -1);
    };
  }, [key]);

  return statuses;
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

// Boolean view on the shared socket, for any surface that wants to
// show a "reconnecting" state: the moment the close handler fires
// every component using this hook re-renders with `false`, and the
// next open flips it back to `true`.
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
