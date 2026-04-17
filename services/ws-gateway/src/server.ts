// ws-gateway: authenticated WebSocket fanout for live odds.
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
// Auth: `oddzilla_access` cookie read during HTTP upgrade. Invalid → 401,
// no graceful fallback.
//
// Fanout: Redis pub/sub `odds:match:{id}`. One subscriber per process;
// per-match subscriptions are refcounted so we only SUBSCRIBE once
// regardless of client count.
//
// Rate limit: 5 msg/s/client token bucket (refill 200 ms, cap 5). Drops
// silently over budget — clients re-read from DB on reconnect.

import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { parse as parseCookies } from "cookie";
import { Redis } from "ioredis";
import pino from "pino";
import { loadEnv, loadAuthEnv } from "@oddzilla/config";
import {
  secretKey,
  verifyAccessToken,
  type AccessTokenClaims,
} from "@oddzilla/auth/jwt";

const ACCESS_COOKIE = "oddzilla_access";
const PUB_CHANNEL_PREFIX = "odds:match:";
const USER_CHANNEL_PREFIX = "user:";
const MAX_SUBSCRIPTIONS_PER_CLIENT = 100;
const TOKEN_BUCKET_CAPACITY = 5;
const TOKEN_BUCKET_REFILL_MS = 200; // 5/s

interface HelloMessage {
  type: "hello";
  userId: string;
  role: "user" | "admin" | "support";
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

// Two Redis clients: a pub/sub subscriber can't issue normal commands, so
// we keep a second for control (ping/healthcheck and future admin actions).
const sub = new Redis(env.REDIS_URL, { lazyConnect: false });
const ctl = new Redis(env.REDIS_URL, { lazyConnect: false });

interface ClientState {
  socket: WebSocket;
  userId: string;
  role: AccessTokenClaims["role"];
  matchIds: Set<string>;
  tokens: number;
  lastRefill: number;
}

const clients = new Set<ClientState>();
const matchRefs = new Map<string, number>();
// User channels carry ticket state changes pushed by services/api (on
// placement) and services/bet-delay (on finalize). Refcounted identically
// to matchRefs — multiple browser tabs subscribe once at Redis level.
const userRefs = new Map<string, number>();

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
    const redisOk = await ctl
      .ping()
      .then((r: string) => r === "PONG")
      .catch(() => false);
    res.writeHead(redisOk ? 200 : 503, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: redisOk ? "ok" : "degraded",
        redis: redisOk ? "ok" : "down",
        clients: clients.size,
        matchSubscriptions: matchRefs.size,
        userSubscriptions: userRefs.size,
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

http.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  void (async () => {
    const claims = await authenticate(req);
    if (!claims) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, claims);
    });
  })();
});

wss.on("connection", (ws: WebSocket, _req: IncomingMessage, claims: AccessTokenClaims) => {
  const state: ClientState = {
    socket: ws,
    userId: claims.sub,
    role: claims.role,
    matchIds: new Set(),
    tokens: TOKEN_BUCKET_CAPACITY,
    lastRefill: Date.now(),
  };
  clients.add(state);
  incrementUserRef(claims.sub);
  send(ws, { type: "hello", userId: claims.sub, role: claims.role });

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
      subscribe(state, msg.matchIds ?? []);
      return;
    }
    if (msg.type === "unsubscribe") {
      unsubscribe(state, msg.matchIds ?? []);
      return;
    }
    send(ws, { type: "error", message: "unknown_message_type" });
  });

  ws.on("close", () => {
    for (const matchId of state.matchIds) {
      decrementMatchRef(matchId);
    }
    state.matchIds.clear();
    decrementUserRef(claims.sub);
    clients.delete(state);
  });

  ws.on("error", (err) => {
    log.debug({ err: err.message }, "client error");
  });
});

function subscribe(state: ClientState, matchIds: string[]) {
  for (const m of matchIds) {
    if (state.matchIds.size >= MAX_SUBSCRIPTIONS_PER_CLIENT) {
      send(state.socket, { type: "error", message: "subscription_limit" });
      return;
    }
    if (state.matchIds.has(m)) continue;
    state.matchIds.add(m);
    incrementMatchRef(m);
  }
}

function unsubscribe(state: ClientState, matchIds: string[]) {
  for (const m of matchIds) {
    if (!state.matchIds.delete(m)) continue;
    decrementMatchRef(m);
  }
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
    return;
  }
  userRefs.set(userId, current - 1);
}

// Single subscriber; dispatch to interested clients.
sub.on("message", (channel: string, payload: string) => {
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

function dispatchOdds(matchId: string, payload: string) {
  for (const client of clients) {
    if (!client.matchIds.has(matchId)) continue;
    if (client.socket.readyState !== WebSocket.OPEN) continue;

    refillTokens(client);
    if (client.tokens <= 0) continue;
    client.tokens -= 1;

    try {
      client.socket.send(payload);
    } catch (err) {
      log.debug({ err: (err as Error).message }, "send failed");
    }
  }
}

// User frames (ticket state changes) bypass the odds rate-limit: they
// are low-volume and the user explicitly cares about them.
function dispatchUser(userId: string, payload: string) {
  for (const client of clients) {
    if (client.userId !== userId) continue;
    if (client.socket.readyState !== WebSocket.OPEN) continue;
    try {
      client.socket.send(payload);
    } catch (err) {
      log.debug({ err: (err as Error).message }, "send user failed");
    }
  }
}

function refillTokens(c: ClientState) {
  const now = Date.now();
  const elapsed = now - c.lastRefill;
  if (elapsed < TOKEN_BUCKET_REFILL_MS) return;
  const add = Math.floor(elapsed / TOKEN_BUCKET_REFILL_MS);
  c.tokens = Math.min(TOKEN_BUCKET_CAPACITY, c.tokens + add);
  c.lastRefill = now;
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

function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  for (const client of clients) {
    try {
      client.socket.close(1001, "server_shutdown");
    } catch {
      // ignore
    }
  }
  clients.clear();
  matchRefs.clear();
  wss.close();
  http.close();
  sub.disconnect();
  ctl.disconnect();
  setTimeout(() => process.exit(0), 100);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
