// ws-gateway: authenticated WebSocket fanout for live odds, ticket
// frames, and live match chat. All three dimensions ride the same
// WebSocket; clients opt into chat independently per matchId via the
// `chat` flag on the subscribe / unsubscribe envelope.
//
// Protocol (see packages/types/src/ws.ts):
//   Client → server:  { type: "subscribe",   matchIds: [...], chat?: boolean }
//                     { type: "unsubscribe", matchIds: [...], chat?: boolean }
//                     { type: "ping" }
//   Server → client:  { type: "hello", userId, role }
//                     { type: "odds", matchId, marketId, outcomeId, publishedOdds, ... }
//                     { type: "chat_message" | "chat_reaction" | "chat_picks_update"
//                       | "chat_match_update" | "chat_viewer_count", matchId, ... }
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
// Live chat broadcast channel — services/api publishes chat_message /
// chat_reaction / chat_picks_update / chat_match_update payloads
// (LiveChatBroadcastFrame in packages/types/src/live-chat.ts) when a
// client posts a message, submits a pick, or the match-state watcher
// detects a goal / HT / FT. Viewer-count deltas are emitted by this
// gateway itself when chatMatchRefs changes.
const CHAT_CHANNEL_PREFIX = "chat:match:";
// Mirror of chatMatchRefs in Redis — the API snapshot endpoint reads
// this so a mid-match joiner sees the correct viewer count before
// the next pub/sub delta arrives.
const VIEWERS_KEY_PREFIX = "chat:viewers:";
const MAX_SUBSCRIPTIONS_PER_CLIENT = 100;
// Hard cap on concurrent connections. Without it, a reconnect storm
// during a Caddy / network blip stacks every browser's reconnects on
// this single process and OOM-kills the container (mem_limit: 256m).
// Tuned for a 256 MiB ws-gateway sized at ~50 KiB-per-client overhead.
// At the cap we send HTTP 503 on the upgrade so the browser keeps its
// existing exponential backoff (with jitter, see use-live-odds.ts).
const MAX_CLIENTS = Number(process.env.WS_MAX_CLIENTS ?? 5000);
// Idle sweep — every minute walk `clients` and drop entries whose
// socket has already closed but `ws.on("close")` somehow never fired
// (TCP-RST without a clean close, GFW-style packet drops). Defensive:
// the close handler is the primary cleanup path.
const STALE_SWEEP_INTERVAL_MS = 60_000;

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
  chat?: boolean;
}
interface UnsubscribeMessage {
  type: "unsubscribe";
  matchIds?: string[];
  chat?: boolean;
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
// Default (false) tolerates same-origin upgrades from server-side
// runtimes that omit Origin. Browsers always send it on WS upgrades.
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
  // Independent from matchIds. A client may subscribe to chat for a
  // match without subscribing to its odds (e.g. a spectator with no
  // bet), or vice versa. Counted against the same per-client cap so
  // a chatty room can't push a client past MAX_SUBSCRIPTIONS_PER_CLIENT
  // by combining the two dimensions.
  chatMatchIds: Set<string>;
}

const clients = new Set<ClientState>();
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
// Chat dimension — refcounted same way as matchRefs. We also use this
// map to derive viewer-count deltas (Notion Epic 1): every time a
// matchId transitions between 0/N or N/0 we publish a chat_viewer_count
// frame onto chat:match:{id} so every other subscriber sees the change.
const chatMatchRefs = new Map<string, number>();
// Reverse index for chat dispatch — same shape as matchSubscribers but
// for the chat dimension. Lets dispatchChat send to interested clients
// in O(subscribers) instead of scanning every connected socket.
const chatMatchSubscribers = new Map<string, Set<ClientState>>();

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
        chatSubscriptions: chatMatchRefs.size,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

// noServer lets us authenticate before accepting the upgrade — invalid
// cookies get a proper HTTP 401 rather than being accepted then closed.
const wss = new WebSocketServer({ noServer: true });

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
  const state: ClientState = {
    socket: ws,
    userId: claims?.sub ?? null,
    role: claims?.role ?? null,
    matchIds: new Set(),
    chatMatchIds: new Set(),
  };
  clients.add(state);
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
      if (msg.chat) subscribeChat(state, msg.matchIds ?? []);
      else subscribe(state, msg.matchIds ?? []);
      return;
    }
    if (msg.type === "unsubscribe") {
      if (msg.chat) unsubscribeChat(state, msg.matchIds ?? []);
      else unsubscribe(state, msg.matchIds ?? []);
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
  for (const matchId of client.matchIds) {
    removeMatchSubscriber(matchId, client);
    decrementMatchRef(matchId);
  }
  client.matchIds.clear();
  for (const matchId of client.chatMatchIds) {
    removeChatMatchSubscriber(matchId, client);
    decrementChatMatchRef(matchId);
  }
  client.chatMatchIds.clear();
  if (client.userId) {
    removeUserSocket(client);
    decrementUserRef(client.userId);
  }
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

function subscribeChat(state: ClientState, matchIds: string[]) {
  for (const m of matchIds) {
    if (totalSubscriptions(state) >= MAX_SUBSCRIPTIONS_PER_CLIENT) {
      send(state.socket, { type: "error", message: "subscription_limit" });
      return;
    }
    if (state.chatMatchIds.has(m)) continue;
    state.chatMatchIds.add(m);
    addChatMatchSubscriber(m, state);
    incrementChatMatchRef(m);
  }
}

function unsubscribeChat(state: ClientState, matchIds: string[]) {
  for (const m of matchIds) {
    if (!state.chatMatchIds.delete(m)) continue;
    removeChatMatchSubscriber(m, state);
    decrementChatMatchRef(m);
  }
}

function totalSubscriptions(state: ClientState): number {
  return state.matchIds.size + state.chatMatchIds.size;
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

function addChatMatchSubscriber(matchId: string, state: ClientState) {
  let set = chatMatchSubscribers.get(matchId);
  if (!set) {
    set = new Set();
    chatMatchSubscribers.set(matchId, set);
  }
  set.add(state);
}

function removeChatMatchSubscriber(matchId: string, state: ClientState) {
  const set = chatMatchSubscribers.get(matchId);
  if (!set) return;
  set.delete(state);
  if (set.size === 0) chatMatchSubscribers.delete(matchId);
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

function incrementChatMatchRef(matchId: string) {
  const current = chatMatchRefs.get(matchId) ?? 0;
  chatMatchRefs.set(matchId, current + 1);
  if (current === 0) {
    sub.subscribe(CHAT_CHANNEL_PREFIX + matchId).catch((err: Error) => {
      log.warn({ err: err.message, matchId }, "redis subscribe chat failed");
    });
  }
  broadcastViewerCount(matchId);
}

function decrementChatMatchRef(matchId: string) {
  const current = chatMatchRefs.get(matchId) ?? 0;
  if (current <= 1) {
    chatMatchRefs.delete(matchId);
    sub.unsubscribe(CHAT_CHANNEL_PREFIX + matchId).catch((err: Error) => {
      log.debug({ err: err.message, matchId }, "redis unsubscribe chat failed");
    });
    // Reaches every other subscriber via Redis, which keeps the
    // viewer count consistent across ws-gateway processes (when we
    // eventually horizontally scale).
    return;
  }
  chatMatchRefs.set(matchId, current - 1);
  broadcastViewerCount(matchId);
}

// Publish a viewer_count frame onto the chat channel so subscribers
// — including this very process via the sub client — see the new
// count. Routing it through Redis (rather than a direct local
// dispatch) keeps the wire format identical for a single-process and
// future multi-process gateway, and means the count is the same
// across processes since every gateway publishes its delta.
//
// Also writes the count to `chat:viewers:{matchId}` so the API's
// snapshot endpoint (GET /live-chat/match/:matchId/room) can return
// the current count to clients that join mid-match — pub/sub frames
// only deliver future deltas, not the current state.
//
// In the single-process case the count is just chatMatchRefs.get(),
// which is the source of truth.
function broadcastViewerCount(matchId: string) {
  const viewerCount = chatMatchRefs.get(matchId) ?? 0;
  const payload = JSON.stringify({
    type: "chat_viewer_count",
    matchId,
    viewerCount,
  });
  if (viewerCount === 0) {
    // Empty room — drop the key entirely. Avoids stale snapshots
    // showing "1 viewer" for hours after the last subscriber leaves.
    ctl.del(VIEWERS_KEY_PREFIX + matchId).catch((err: Error) => {
      log.debug({ err: err.message, matchId }, "viewers key delete failed");
    });
  } else {
    // 1 hour TTL — re-extended on every delta. A long-quiet room
    // will let the key fall out; the next subscriber bringing the
    // count back above zero re-sets it.
    ctl
      .set(VIEWERS_KEY_PREFIX + matchId, viewerCount.toString(), "EX", 3600)
      .catch((err: Error) => {
        log.debug({ err: err.message, matchId }, "viewers key set failed");
      });
  }
  ctl
    .publish(CHAT_CHANNEL_PREFIX + matchId, payload)
    .catch((err: Error) => {
      log.debug(
        { err: err.message, matchId },
        "viewer count publish failed",
      );
    });
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
  if (channel.startsWith(CHAT_CHANNEL_PREFIX)) {
    const matchId = channel.slice(CHAT_CHANNEL_PREFIX.length);
    dispatchChat(matchId, payload);
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
    let outbound = payload;

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

    try {
      client.socket.send(outbound);
    } catch (err) {
      log.debug({ err: (err as Error).message }, "send failed");
    }
  }
}

function dispatchUser(userId: string, payload: string) {
  const subs = userSockets.get(userId);
  if (!subs) return;
  for (const client of subs) {
    if (client.socket.readyState !== WebSocket.OPEN) continue;
    try {
      client.socket.send(payload);
    } catch (err) {
      log.debug({ err: (err as Error).message }, "send user failed");
    }
  }
}

function dispatchChat(matchId: string, payload: string) {
  const subs = chatMatchSubscribers.get(matchId);
  if (!subs) return;
  for (const client of subs) {
    if (client.socket.readyState !== WebSocket.OPEN) continue;
    try {
      client.socket.send(payload);
    } catch (err) {
      log.debug({ err: (err as Error).message }, "send chat failed");
    }
  }
}

function send(ws: WebSocket, msg: OutboundFrame) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Socket may have closed between check and send — ignore.
  }
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
  chatMatchRefs.clear();
  chatMatchSubscribers.clear();
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
