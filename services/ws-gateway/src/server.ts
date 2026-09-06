// ws-gateway: authenticated WebSocket fanout for live odds and ticket
// frames. Both dimensions ride the same WebSocket.
//
// Protocol (see packages/types/src/ws.ts):
//   Client → server:  { type: "subscribe",   matchIds: [...] }
//                     { type: "unsubscribe", matchIds: [...] }
//                     { type: "ping" }
//   Server → client:  { type: "hello", userId, role }
//                     { type: "odds", matchId, marketId, outcomeId, publishedOdds, ... }
//                     { type: "pong" }
//                     { type: "error", message }
//
// Auth: `oddzilla_access` cookie read during HTTP upgrade. Authenticated
// clients also subscribe to a private `user:{userId}` channel for ticket
// frames. Anonymous clients are accepted — they only receive public
// `odds:match:{id}` fan-out, which is the same data SSR already serves to
// logged-out visitors. This keeps live odds flowing on the storefront for
// browsing visitors who haven't signed up yet.
//
// Fanout: Redis pub/sub `odds:match:{id}`. One subscriber per process;
// per-match subscriptions are refcounted so we only SUBSCRIBE once
// regardless of client count.
//
// No rate limit. The gateway is a pure forwarder — every odds frame
// pushed by odds-publisher reaches every interested, OPEN client. A
// sportsbook UI cannot tolerate dropped odds: the bet slip's
// auto-refresh keys off WS ticks (bet-slip-rail.tsx) and a missed
// frame surfaces as "odds moved since you clicked" at placement. The
// upstream rate is naturally bounded by Oddin's broker (~one
// odds_change burst per match per few seconds); the per-client bound
// is volume × fan-in × match count. Hard ceilings stay on the
// connection cap (MAX_CLIENTS) and per-client subscription cap
// (MAX_SUBSCRIPTIONS_PER_CLIENT) — those are about gateway memory,
// not throughput.

import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { parse as parseCookies } from "cookie";
import { Redis } from "ioredis";
import pino from "pino";
import postgres from "postgres";
import { loadEnv, loadAuthEnv, corsOrigins } from "@oddzilla/config";
import {
  secretKey,
  verifyAccessToken,
  type AccessTokenClaims,
} from "@oddzilla/auth/jwt";
import {
  loadCascade,
  resolveBp,
  applyAdjustment,
  EMPTY_CASCADE,
  type BettorAdjustmentCascade,
} from "./bettor-adjustment.js";

const ACCESS_COOKIE = "oddzilla_access";
const PUB_CHANNEL_PREFIX = "odds:match:";
const USER_CHANNEL_PREFIX = "user:";
// Admin mutation channel. The api process publishes the userId here on
// every PUT/DELETE under /admin/users/:userId/odds-adjustment/*; the
// gateway drops that user's cached cascade on receipt. Single channel
// per gateway (not pattern-matched) so the Redis subscriber stays cheap.
const ADJUSTMENT_INVALIDATE_CHANNEL = "bettor_adjustment_invalidated";
const REQUEST_ID_HEADER = "x-request-id";
// Inbound IDs are echoed verbatim only when they match this shape.
// Anything else is treated as missing — same defense-in-depth as the
// api + web layers.
const REQUEST_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SUBSCRIPTIONS_PER_CLIENT = 100;
// Hard cap on concurrent connections. Without it, a reconnect storm
// during a Caddy / network blip stacks every browser's reconnects on
// this single process and OOM-kills the container (mem_limit: 256m).
// Tuned for a 256 MiB ws-gateway sized at ~50 KiB-per-client overhead.
// At the cap we send HTTP 503 on the upgrade so the browser keeps its
// existing exponential backoff (with jitter, see use-live-odds.ts).
const MAX_CLIENTS = Number(process.env.WS_MAX_CLIENTS ?? 5000);
// Hard cap on a single inbound WebSocket frame. The largest legitimate
// client message is a subscribe envelope with up to
// MAX_SUBSCRIPTIONS_PER_CLIENT match ids — a few KiB. Without this the
// `ws` default is 100 MiB/frame: one anonymous frame (buffered, then
// .toString()'d to ~2x as a UTF-16 string) OOM-kills the 256 MiB
// container. ws auto-closes oversize frames with 1009 before allocating.
const WS_MAX_PAYLOAD_BYTES = Number(process.env.WS_MAX_PAYLOAD_BYTES ?? 16 * 1024);
// Per-connection inbound message rate limit (token bucket). A single
// socket spamming subscribe/unsubscribe churns Redis SUBSCRIBE/UNSUBSCRIBE
// and per-match refcounts; cap the sustained rate while allowing a burst.
const WS_MSG_RATE_PER_SEC = Number(process.env.WS_MSG_RATE_PER_SEC ?? 20);
const WS_MSG_BURST = Number(process.env.WS_MSG_BURST ?? 40);
// Max concurrent connections from a single client IP (X-Forwarded-For
// from Caddy, else the socket peer). Stops one source from eating the
// global MAX_CLIENTS budget via a reconnect flood. 0 disables the cap.
const WS_MAX_CLIENTS_PER_IP = Number(process.env.WS_MAX_CLIENTS_PER_IP ?? 50);
// Idle sweep — every minute walk `clients` and drop entries whose
// socket has already closed but `ws.on("close")` somehow never fired
// (TCP-RST without a clean close, GFW-style packet drops). Defensive:
// the close handler is the primary cleanup path.
const STALE_SWEEP_INTERVAL_MS = 60_000;
// Per-socket outbound backpressure ceiling. `ws.send()` never blocks: when
// the kernel socket buffer is full it queues the frame in the sender and
// returns, so a consumer that stops draining (throttled mobile, a laptop
// asleep on a half-open TCP connection whose readyState is still OPEN, a
// browser tab the OS has frozen) accumulates every subsequent odds frame
// in this process's heap. Nothing bounded that before: the growth tracks
// FEED VOLUME, not client count, which is why this container OOM-killed
// four times on 2026-09-03 while serving a couple of dozen sockets, each
// time within half an hour of the feed stack restarting and replaying.
//
// A slow consumer past the ceiling is disconnected rather than having
// frames silently dropped. Dropping would leave that client quoting a
// price the book has moved off of with no signal that it happened;
// closing makes the browser reconnect (exponential backoff with jitter,
// see use-live-odds.ts), resubscribe, and re-read current state from
// Postgres via SSR — invariant 7's reconnect path, which exists exactly
// so pub/sub is allowed to be lossy.
const WS_MAX_BUFFERED_BYTES = Number(
  process.env.WS_MAX_BUFFERED_BYTES ?? 1024 * 1024,
);

interface HelloMessage {
  type: "hello";
  userId: string | null;
  role: "user" | "admin" | "support" | null;
}
interface PongMessage {
  type: "pong";
}
interface ErrorMessage {
  type: "error";
  message: string;
}
type OutboundFrame = HelloMessage | PongMessage | ErrorMessage;

interface SubscribeMessage {
  type: "subscribe";
  matchIds?: string[];
}
interface UnsubscribeMessage {
  type: "unsubscribe";
  matchIds?: string[];
}
interface PingMessage {
  type: "ping";
}
type InboundFrame = SubscribeMessage | UnsubscribeMessage | PingMessage;

const env = loadEnv();
const auth = loadAuthEnv();
const log = pino({ level: env.LOG_LEVEL, base: { service: env.SERVICE_NAME } });

const jwtKey = secretKey(auth.jwtSecret);

// Origin allowlist for the WS upgrade handshake. SameSite=Lax on the
// access cookie is the existing mitigation against CSWSH, but Firefox
// historically diverged and non-browser clients can still send cookies
// cross-origin. Mirror the API's CSRF plugin: parse CORS_ORIGINS as a
// comma-separated list, normalize (lowercase host, drop trailing slash),
// and compare exactly. Single-value Origin only — header arrays are
// rejected outright.
const allowedOrigins = new Set(corsOrigins(env).map(normalizeOrigin));
// When set to "true", require the Origin header on every upgrade.
// docker-compose.yml defaults this to true (2026-09-03): browsers always
// send Origin on WS upgrades, nothing server-side opens /ws, and a bare
// script or curl does not send one — so strict mode turns away the naive
// odds scraper for free. The code default stays false so a local
// `pnpm dev` without Compose keeps the tolerant behaviour.
const corsOriginsStrict = process.env.CORS_ORIGINS_STRICT === "true";

function normalizeOrigin(origin: string): string {
  try {
    const u = new URL(origin);
    return `${u.protocol}//${u.host.toLowerCase()}`;
  } catch {
    return origin.toLowerCase().replace(/\/+$/, "");
  }
}

// Two Redis clients: a pub/sub subscriber can't issue normal commands, so
// we keep a second for control (ping/healthcheck and future admin actions).
const sub = new Redis(env.REDIS_URL, { lazyConnect: false });
const ctl = new Redis(env.REDIS_URL, { lazyConnect: false });

// Postgres pool used only for loading a connecting user's odds-adjustment
// cascade. The query is one indexed lookup per authed upgrade; the cache
// holds the result for the lifetime of the connection (or until an admin
// mutation invalidates it via the pub/sub channel below). Capped at 4
// connections — odds-adjustment hot paths don't need more, and ws-gateway
// shouldn't compete with the api process for the main pool.
const pg = postgres(env.DATABASE_URL, { max: 4, prepare: false });

// In-memory cascade cache keyed by userId. Loaded once per authed
// connection and shared across all sockets that user opens (multi-tab).
// Invalidated by:
//   1. Admin write → Redis publish on ADJUSTMENT_INVALIDATE_CHANNEL
//   2. Last socket for the user disconnects → entry dropped (keeps the
//      memory bounded; next login re-loads)
const cascadeCache = new Map<string, BettorAdjustmentCascade>();

// Track the subscribe-side connection so /healthz can fail when it goes
// down — without this, the control client stays green while user/odds
// frames silently stop being delivered and Compose keeps the container
// healthy. ioredis emits 'ready'/'end'/'reconnecting' state events.
let subReady = false;
sub.on("ready", () => {
  subReady = true;
  log.info("sub redis ready");
  // (Re-)subscribe to the global invalidation channel on every (re)ready.
  // Independent of per-user / per-match channels — those are managed by
  // refcount; this one is permanent.
  sub.subscribe(ADJUSTMENT_INVALIDATE_CHANNEL).catch((err: Error) => {
    log.warn(
      { err: err.message, channel: ADJUSTMENT_INVALIDATE_CHANNEL },
      "redis subscribe invalidation channel failed",
    );
  });
});
sub.on("end", () => {
  subReady = false;
  log.warn("sub redis ended");
});
sub.on("reconnecting", () => {
  subReady = false;
});
sub.on("error", (err: Error) => {
  log.warn({ err: err.message }, "sub redis error");
});

interface ClientState {
  socket: WebSocket;
  // Anonymous clients have no userId and never get a `user:{id}` Redis
  // subscription — they're public-odds-only.
  userId: string | null;
  role: AccessTokenClaims["role"] | null;
  matchIds: Set<string>;
  // Real client IP (X-Forwarded-For from Caddy, else socket peer). Held so
  // the per-IP connection count can be released on disconnect.
  ip: string;
  // Per-connection inbound-message token bucket (see WS_MSG_* consts).
  msgTokens: number;
  msgLastRefillMs: number;
  // Set by cleanupClient so the three paths that can reach it (close
  // event, stale sweep, slow-consumer eviction mid-dispatch) each run
  // the teardown once. Without it a socket evicted during dispatch is
  // torn down again by its own close event and double-decrements the
  // per-IP counter.
  cleanedUp: boolean;
}

const clients = new Set<ClientState>();
// Count of sockets disconnected for exceeding WS_MAX_BUFFERED_BYTES.
// Surfaced on /healthz: a non-zero and climbing value is the signal
// that outbound volume is outrunning some consumer, which is the shape
// the pre-fix OOMs had.
let slowClientDrops = 0;
const matchRefs = new Map<string, number>();
// User channels carry ticket state changes pushed by services/api (on
// placement) and services/bet-delay (on finalize). Refcounted identically
// to matchRefs — multiple browser tabs subscribe once at Redis level.
const userRefs = new Map<string, number>();
// Reverse indexes for O(subscribers) dispatch. The Redis refcount maps
// above answer "do we need a Redis SUBSCRIBE?"; these answer "which
// sockets should receive this frame?". Maintained at the same lifecycle
// points as the refcount maps (subscribe/unsubscribe and close/sweep).
const matchSubscribers = new Map<string, Set<ClientState>>();
const userSockets = new Map<string, Set<ClientState>>();
// Concurrent connection count per client IP. Bounds a single source's
// share of the global MAX_CLIENTS budget so one host can't reconnect-flood
// the gateway off the air for everyone. Incremented on connection accept,
// released on cleanup.
const ipCounts = new Map<string, number>();

// Real client IP for rate/connection accounting. Caddy overwrites
// X-Forwarded-For with the true peer on the /ws upgrade (see Caddyfile
// ws_proxy), so the first hop is trustworthy. Falls back to the socket peer
// when XFF is absent (direct / dev connections).
function clientIpOf(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  if (raw) {
    const first = raw.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

async function authenticate(req: IncomingMessage): Promise<AccessTokenClaims | null> {
  const cookieHeader = req.headers.cookie ?? "";
  const cookies = parseCookies(cookieHeader);
  const token = cookies[ACCESS_COOKIE];
  if (!token) return null;
  try {
    return await verifyAccessToken(token, jwtKey);
  } catch {
    return null;
  }
}

const startedAt = Date.now();

const http = createServer(async (req, res) => {
  if (req.url === "/healthz") {
    const ctlOk = await ctl
      .ping()
      .then((r: string) => r === "PONG")
      .catch(() => false);
    // Both Redis clients must be live for fanout to work. The control
    // client serves admin pings; the sub client carries every odds and
    // user frame — degrading either should restart the container.
    const redisOk = ctlOk && subReady;
    res.writeHead(redisOk ? 200 : 503, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: redisOk ? "ok" : "degraded",
        redis: redisOk ? "ok" : "down",
        redisCtl: ctlOk ? "ok" : "down",
        redisSub: subReady ? "ok" : "down",
        clients: clients.size,
        maxClients: MAX_CLIENTS,
        matchSubscriptions: matchRefs.size,
        userSubscriptions: userRefs.size,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        ...memoryStats(),
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

// noServer lets us authenticate before accepting the upgrade — invalid
// cookies get a proper HTTP 401 rather than being accepted then closed.
const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

function extractRequestId(req: IncomingMessage): string | undefined {
  const raw = req.headers[REQUEST_ID_HEADER];
  if (typeof raw === "string" && REQUEST_ID_SHAPE.test(raw)) return raw;
  return undefined;
}

http.on("upgrade", (req, socket, head) => {
  const requestId = extractRequestId(req);
  if (req.url !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  // Cross-site WebSocket hijacking defense. Run BEFORE authenticate()
  // so an attacker page can't even trigger the cookie read on a
  // disallowed origin. Mirrors services/api/src/plugins/csrf.ts: single
  // Origin value only, exact normalized match against CORS_ORIGINS.
  // Multi-value Origin (header array) is rejected — never produced by
  // a real browser, almost always a smuggling attempt.
  const rawOrigin = req.headers.origin;
  if (Array.isArray(rawOrigin)) {
    log.warn({ origin: rawOrigin }, "ws upgrade rejected — multi-value Origin");
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  if (!rawOrigin) {
    if (corsOriginsStrict) {
      log.warn("ws upgrade rejected — missing Origin (strict mode)");
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    // Tolerate missing Origin for non-strict mode (server-side
    // runtimes on same-origin upgrades).
  } else if (!allowedOrigins.has(normalizeOrigin(rawOrigin))) {
    log.warn({ origin: rawOrigin }, "ws upgrade rejected — origin not allowed");
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  void (async () => {
    // Authentication is best-effort: a missing or invalid cookie just
    // means this is an anonymous browsing session. The connection is
    // accepted either way; the user-channel subscription only happens
    // for authenticated clients.
    const claims = await authenticate(req);
    if (clients.size >= MAX_CLIENTS) {
      // Reject new upgrades over the cap. Browser-side reconnect logic
      // (use-live-odds.ts) backs off with jitter, so this isn't a busy
      // loop — it's a load-shed signal.
      log.warn(
        { clients: clients.size, max: MAX_CLIENTS, requestId },
        "rejecting upgrade — client cap reached",
      );
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    // Per-IP connection cap. Stops a single source from consuming the whole
    // global budget via a reconnect flood. Read-only check here; the count
    // is incremented when the connection is accepted and released on close.
    if (WS_MAX_CLIENTS_PER_IP > 0) {
      const ip = clientIpOf(req);
      if ((ipCounts.get(ip) ?? 0) >= WS_MAX_CLIENTS_PER_IP) {
        log.warn(
          { ip, perIp: ipCounts.get(ip), max: WS_MAX_CLIENTS_PER_IP, requestId },
          "rejecting upgrade — per-IP cap reached",
        );
        socket.write(
          "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\n\r\n",
        );
        socket.destroy();
        return;
      }
    }
    log.debug(
      { userId: claims?.sub ?? null, requestId, clients: clients.size + 1 },
      "ws upgrade accepted",
    );
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, claims);
    });
  })();
});

wss.on("connection", (ws: WebSocket, _req: IncomingMessage, claims: AccessTokenClaims | null) => {
  const ip = clientIpOf(_req);
  const state: ClientState = {
    socket: ws,
    userId: claims?.sub ?? null,
    role: claims?.role ?? null,
    matchIds: new Set(),
    ip,
    msgTokens: WS_MSG_BURST,
    msgLastRefillMs: Date.now(),
    cleanedUp: false,
  };
  clients.add(state);
  ipCounts.set(ip, (ipCounts.get(ip) ?? 0) + 1);
  if (claims) {
    addUserSocket(state);
    incrementUserRef(claims.sub);
    // Cascade load is best-effort: a DB hiccup just leaves the user
    // with the empty cascade (raw odds — same as a user with no rule).
    // Slightly stale through an admin write that races the load, but
    // the invalidation channel resolves that within milliseconds.
    void loadCascadeForUser(claims.sub);
  }
  send(ws, {
    type: "hello",
    userId: claims?.sub ?? null,
    role: claims?.role ?? null,
  });

  ws.on("message", (raw) => {
    // Per-connection inbound rate limit (token bucket). Refill by elapsed
    // time (capped at the burst size), then drop frames that exceed the
    // rate BEFORE parsing — so a flood can't churn Redis subscribe/
    // unsubscribe or burn CPU on JSON.parse. Legit clients (a few subscribe
    // envelopes per navigation) never approach the limit.
    const now = Date.now();
    state.msgTokens = Math.min(
      WS_MSG_BURST,
      state.msgTokens + ((now - state.msgLastRefillMs) / 1000) * WS_MSG_RATE_PER_SEC,
    );
    state.msgLastRefillMs = now;
    if (state.msgTokens < 1) {
      // Silently drop — emitting an error per dropped frame would itself be
      // attacker-controlled work. The connection stays open.
      return;
    }
    state.msgTokens -= 1;

    let msg: InboundFrame;
    try {
      msg = JSON.parse(raw.toString()) as InboundFrame;
    } catch {
      send(ws, { type: "error", message: "invalid_json" });
      return;
    }

    if (msg.type === "ping") {
      send(ws, { type: "pong" });
      return;
    }
    if (msg.type === "subscribe") {
      subscribe(state, msg.matchIds ?? []);
      return;
    }
    if (msg.type === "unsubscribe") {
      unsubscribe(state, msg.matchIds ?? []);
      return;
    }
    send(ws, { type: "error", message: "unknown_message_type" });
  });

  ws.on("close", () => cleanupClient(state));

  ws.on("error", (err) => {
    log.debug({ err: err.message }, "client error");
  });
});

// Release every Redis-side refcount the client held and remove it
// from the active set. Called from both the WebSocket close event
// and the periodic stale sweep; the two paths previously inlined
// identical cleanup logic.
function cleanupClient(client: ClientState) {
  if (client.cleanedUp) return;
  client.cleanedUp = true;
  for (const matchId of client.matchIds) {
    removeMatchSubscriber(matchId, client);
    decrementMatchRef(matchId);
  }
  client.matchIds.clear();
  if (client.userId) {
    removeUserSocket(client);
    decrementUserRef(client.userId);
  }
  const ipLeft = (ipCounts.get(client.ip) ?? 1) - 1;
  if (ipLeft <= 0) ipCounts.delete(client.ip);
  else ipCounts.set(client.ip, ipLeft);
  clients.delete(client);
}

function subscribe(state: ClientState, matchIds: string[]) {
  for (const m of matchIds) {
    if (totalSubscriptions(state) >= MAX_SUBSCRIPTIONS_PER_CLIENT) {
      send(state.socket, { type: "error", message: "subscription_limit" });
      return;
    }
    if (state.matchIds.has(m)) continue;
    state.matchIds.add(m);
    addMatchSubscriber(m, state);
    incrementMatchRef(m);
  }
}

function unsubscribe(state: ClientState, matchIds: string[]) {
  for (const m of matchIds) {
    if (!state.matchIds.delete(m)) continue;
    removeMatchSubscriber(m, state);
    decrementMatchRef(m);
  }
}

function totalSubscriptions(state: ClientState): number {
  return state.matchIds.size;
}

function addMatchSubscriber(matchId: string, state: ClientState) {
  let set = matchSubscribers.get(matchId);
  if (!set) {
    set = new Set();
    matchSubscribers.set(matchId, set);
  }
  set.add(state);
}

function removeMatchSubscriber(matchId: string, state: ClientState) {
  const set = matchSubscribers.get(matchId);
  if (!set) return;
  set.delete(state);
  if (set.size === 0) matchSubscribers.delete(matchId);
}

function addUserSocket(state: ClientState) {
  if (state.userId === null) return;
  let set = userSockets.get(state.userId);
  if (!set) {
    set = new Set();
    userSockets.set(state.userId, set);
  }
  set.add(state);
}

function removeUserSocket(state: ClientState) {
  if (state.userId === null) return;
  const set = userSockets.get(state.userId);
  if (!set) return;
  set.delete(state);
  if (set.size === 0) userSockets.delete(state.userId);
}

function incrementMatchRef(matchId: string) {
  const current = matchRefs.get(matchId) ?? 0;
  matchRefs.set(matchId, current + 1);
  if (current === 0) {
    sub.subscribe(PUB_CHANNEL_PREFIX + matchId).catch((err: Error) => {
      log.warn({ err: err.message, matchId }, "redis subscribe failed");
    });
  }
}

function decrementMatchRef(matchId: string) {
  const current = matchRefs.get(matchId) ?? 0;
  if (current <= 1) {
    matchRefs.delete(matchId);
    sub.unsubscribe(PUB_CHANNEL_PREFIX + matchId).catch((err: Error) => {
      log.debug({ err: err.message, matchId }, "redis unsubscribe failed");
    });
    return;
  }
  matchRefs.set(matchId, current - 1);
}

function incrementUserRef(userId: string) {
  const current = userRefs.get(userId) ?? 0;
  userRefs.set(userId, current + 1);
  if (current === 0) {
    sub.subscribe(USER_CHANNEL_PREFIX + userId).catch((err: Error) => {
      log.warn({ err: err.message, userId }, "redis subscribe user failed");
    });
  }
}

function decrementUserRef(userId: string) {
  const current = userRefs.get(userId) ?? 0;
  if (current <= 1) {
    userRefs.delete(userId);
    sub.unsubscribe(USER_CHANNEL_PREFIX + userId).catch((err: Error) => {
      log.debug({ err: err.message, userId }, "redis unsubscribe user failed");
    });
    // Last socket for this user gone → drop the cascade entry. Next
    // login re-loads from PG. Keeps the cache bounded by live audience,
    // not by lifetime customer count.
    cascadeCache.delete(userId);
    return;
  }
  userRefs.set(userId, current - 1);
}

// Best-effort cascade load. Concurrent connections for the same user
// race here, but loadCascade is idempotent and the Map.set is atomic;
// worst case we run the SELECT twice. The cache key uses the canonical
// userId string — same value the invalidation channel publishes.
async function loadCascadeForUser(userId: string): Promise<void> {
  try {
    const cascade = await loadCascade(pg, userId);
    cascadeCache.set(userId, cascade);
  } catch (err) {
    log.warn({ err: (err as Error).message, userId }, "cascade load failed");
    // Don't insert an empty cascade on error — the resolver already
    // falls back to "no rule" when the cache is missing.
  }
}

// Single subscriber; dispatch to interested clients.
sub.on("message", (channel: string, payload: string) => {
  if (channel === ADJUSTMENT_INVALIDATE_CHANNEL) {
    // payload = userId. Drop the cached cascade so the next odds frame
    // for that user reloads from PG. Re-load is lazy: the next time
    // the user receives a tick after a fresh load completes, the new
    // bp takes effect. In the gap (microseconds) the user briefly
    // sees the pre-mutation price — acceptable since placement always
    // re-validates against the current cascade in the tx.
    cascadeCache.delete(payload);
    // Eagerly refresh if this user is still connected — keeps the
    // common case (admin mutation while user is online) hot.
    if (userSockets.has(payload)) void loadCascadeForUser(payload);
    return;
  }
  if (channel.startsWith(PUB_CHANNEL_PREFIX)) {
    const matchId = channel.slice(PUB_CHANNEL_PREFIX.length);
    dispatchOdds(matchId, payload);
    return;
  }
  if (channel.startsWith(USER_CHANNEL_PREFIX)) {
    const userId = channel.slice(USER_CHANNEL_PREFIX.length);
    dispatchUser(userId, payload);
    return;
  }
});

// Minimal shape we read off the odds payload to resolve cascade per
// subscriber. odds-publisher's OutboundPayload carries every field we
// need (sportId / tournamentId / matchId / publishedOdds / probability)
// after the wire-format extension; older field omissions degrade
// gracefully (resolver gates on bp=0 → fast path).
interface OddsFrame {
  type: string;
  matchId: string;
  marketId: string;
  outcomeId: string;
  publishedOdds: string;
  probability?: string;
  sportId?: number;
  tournamentId?: number;
}

function dispatchOdds(matchId: string, payload: string) {
  const subs = matchSubscribers.get(matchId);
  if (!subs) return;

  // Parse once per frame, only when at least one subscriber is authed
  // AND has a cached cascade. The very common case (anonymous / no
  // bettor rules) skips the parse entirely.
  let frame: OddsFrame | null = null;
  let frameInvalid = false;
  // Cache rewritten payloads per bp value so two subscribers with the
  // same bp share the JSON-stringify work. Keyed by integer bp.
  let rewriteCache: Map<number, string> | null = null;

  for (const client of subs) {
    if (client.socket.readyState !== WebSocket.OPEN) continue;
    const userId = client.userId;
    let outbound: string = payload;

    if (userId !== null) {
      const cascade = cascadeCache.get(userId);
      if (cascade && !cascade.empty) {
        if (frame === null && !frameInvalid) {
          try {
            frame = JSON.parse(payload) as OddsFrame;
          } catch {
            frameInvalid = true;
          }
        }
        if (
          frame &&
          frame.sportId !== undefined &&
          frame.tournamentId !== undefined
        ) {
          const bp = resolveBp(
            cascade,
            frame.matchId,
            frame.tournamentId,
            frame.sportId,
          );
          if (bp !== 0) {
            if (rewriteCache === null) rewriteCache = new Map();
            let rewritten = rewriteCache.get(bp);
            if (rewritten === undefined) {
              const adjusted = applyAdjustment(
                frame.publishedOdds,
                frame.probability ?? null,
                bp,
              );
              if (adjusted !== frame.publishedOdds) {
                rewritten = JSON.stringify({
                  ...frame,
                  publishedOdds: adjusted,
                });
              } else {
                rewritten = payload;
              }
              rewriteCache.set(bp, rewritten);
            }
            outbound = rewritten;
          }
        }
      }
    }

    sendToClient(client, outbound);
  }
}

function dispatchUser(userId: string, payload: string) {
  const subs = userSockets.get(userId);
  if (!subs) return;
  for (const client of subs) {
    sendToClient(client, payload);
  }
}

function send(ws: WebSocket, msg: OutboundFrame) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Socket may have closed between check and send — ignore.
  }
}

// The single outbound path for every fan-out frame (odds, user).
// Enforces the backpressure ceiling documented on WS_MAX_BUFFERED_BYTES:
// a socket that has stopped draining is disconnected instead of being
// allowed to queue the feed in this process's heap.
//
// Safe to call while iterating a subscriber Set: cleanupClient() deletes
// the client from those Sets, and deleting the current element during a
// Set for...of is well-defined in JS.
function sendToClient(client: ClientState, payload: string) {
  if (client.socket.readyState !== WebSocket.OPEN) return;
  if (client.socket.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
    slowClientDrops += 1;
    log.warn(
      {
        ip: client.ip,
        userId: client.userId,
        bufferedBytes: client.socket.bufferedAmount,
        limit: WS_MAX_BUFFERED_BYTES,
        matchSubs: client.matchIds.size,
      },
      "dropping slow consumer — outbound buffer over limit",
    );
    // terminate() rather than close(): a socket this far behind is not
    // going to complete a closing handshake, and close() would leave it
    // in CLOSING with the queued frames still referenced until the
    // handshake times out — which is the memory we are trying to free.
    client.socket.terminate();
    cleanupClient(client);
    return;
  }
  try {
    client.socket.send(payload);
  } catch (err) {
    log.debug({ err: (err as Error).message }, "send failed");
  }
}

// Heap + outbound-buffer snapshot. Reported on /healthz and logged once
// per sweep so a slow climb is visible in the logs BEFORE the container
// hits mem_limit — the four OOM kills on 2026-09-03 left nothing behind
// but V8's own death notice, which says the heap was full and nothing
// about what filled it.
function memoryStats() {
  const mem = process.memoryUsage();
  let bufferedBytes = 0;
  let maxBufferedBytes = 0;
  for (const client of clients) {
    const buffered = client.socket.bufferedAmount;
    bufferedBytes += buffered;
    if (buffered > maxBufferedBytes) maxBufferedBytes = buffered;
  }
  return {
    heapUsedMb: Math.round(mem.heapUsed / 1048576),
    heapTotalMb: Math.round(mem.heapTotal / 1048576),
    rssMb: Math.round(mem.rss / 1048576),
    externalMb: Math.round(mem.external / 1048576),
    bufferedBytes,
    maxBufferedBytes,
    slowClientDrops,
  };
}

http.listen(env.WS_GATEWAY_PORT, "0.0.0.0", () => {
  log.info({ port: env.WS_GATEWAY_PORT }, "ws-gateway listening");
});

// Periodic sweep — drop ClientState entries whose underlying socket is
// already CLOSED. The ws.on('close') handler is the primary cleanup
// path; this catches edge cases where the close event never fired
// (TCP-RST without a clean FIN).
const staleSweep = setInterval(() => {
  let dropped = 0;
  for (const client of clients) {
    if (
      client.socket.readyState === WebSocket.CLOSED ||
      client.socket.readyState === WebSocket.CLOSING
    ) {
      cleanupClient(client);
      dropped += 1;
    }
  }
  if (dropped > 0) log.info({ dropped, remaining: clients.size }, "stale sweep");
  log.info(
    {
      clients: clients.size,
      matchSubscriptions: matchRefs.size,
      userSubscriptions: userRefs.size,
      ...memoryStats(),
    },
    "gateway stats",
  );
}, STALE_SWEEP_INTERVAL_MS);
// Don't block process exit on the timer.
staleSweep.unref();

function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  clearInterval(staleSweep);
  for (const client of clients) {
    try {
      client.socket.close(1001, "server_shutdown");
    } catch {
      // ignore
    }
  }
  clients.clear();
  matchRefs.clear();
  matchSubscribers.clear();
  userSockets.clear();
  userRefs.clear();
  wss.close();
  http.close();
  sub.disconnect();
  ctl.disconnect();
  cascadeCache.clear();
  void pg.end({ timeout: 5 });
  setTimeout(() => process.exit(0), 100);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
