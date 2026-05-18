// Fastify REST API. Boots, registers plugins + routes, serves /healthz.
// Route surface: /auth, /users, /wallet, /catalog, /admin (role-gated).

import Fastify, { type FastifyError } from "fastify";
import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { loadEnv, loadAuthEnv, corsOrigins } from "@oddzilla/config";
import type { HealthResponse } from "@oddzilla/types";
import dbPlugin from "./plugins/db.js";
import redisPlugin from "./plugins/redis.js";
import authPlugin from "./plugins/auth.js";
import csrfPlugin from "./plugins/csrf.js";
import authRoutes from "./modules/auth/routes.js";
import usersRoutes from "./modules/users/routes.js";
import walletRoutes from "./modules/wallet/routes.js";
import catalogRoutes from "./modules/catalog/routes.js";
import betsRoutes from "./modules/bets/routes.js";
import cashoutRoutes from "./modules/cashout/routes.js";
import adminRoutes from "./modules/admin/routes.js";
import oddsConfigRoutes from "./modules/admin/odds-config.js";
import combiBoostConfigRoutes from "./modules/admin/combi-boost-config.js";
import zillaflashConfigRoutes from "./modules/admin/zillaflash-config.js";
import adminSportsRoutes from "./modules/admin/sports.js";
import adminCashoutConfigRoutes from "./modules/admin/cashout-config.js";
import betProductsRoutes from "./modules/admin/bet-products.js";
import adminTicketsRoutes from "./modules/admin/tickets.js";
import adminWithdrawalsRoutes from "./modules/admin/withdrawals.js";
import adminDepositsRoutes from "./modules/admin/deposits.js";
import adminDashboardRoutes from "./modules/admin/dashboard.js";
import adminUsersRoutes from "./modules/admin/users.js";
import adminAuditRoutes from "./modules/admin/audit.js";
import adminFeedRoutes from "./modules/admin/feed.js";
import adminWedgedMatchesRoutes from "./modules/admin/wedged-matches.js";
import adminLogsRoutes from "./modules/admin/logs.js";
import adminFeSettingsRoutes from "./modules/admin/fe-settings.js";
import adminCompetitorsRoutes from "./modules/admin/competitors.js";
import adminTournamentsRoutes from "./modules/admin/tournaments.js";
import adminMonitoringRoutes, { startMonitoringSampler } from "./modules/admin/monitoring.js";
import adminDeployRoutes from "./modules/admin/deploy.js";
import communityRoutes from "./modules/community/routes.js";
import communityAvatarRoutes from "./modules/community/avatars.js";
import communityAnalysesRoutes from "./modules/community/analyses.js";
import communityCompetitionsRoutes from "./modules/community/competitions.js";
import communityNotificationsRoutes from "./modules/community/notifications.js";
import adminCommunityRoutes from "./modules/admin/community.js";
import adminCompetitionsRoutes from "./modules/admin/competitions.js";
import adminAvatarRoutes from "./modules/admin/avatars.js";
import widgetsRoutes from "./modules/widgets/routes.js";
import betbuilderRoutes from "./modules/betbuilder/routes.js";
import zillatipsRoutes from "./modules/zillatips/routes.js";
import zillafactsRoutes from "./modules/zillafacts/routes.js";
import zillaflashRoutes from "./modules/zillaflash/routes.js";
import { startZillaFlashRotation } from "./modules/zillaflash/engine.js";
import devicesRoutes from "./modules/devices/routes.js";
import liveChatRoutes from "./modules/live-chat/routes.js";
import { startMatchWatcher } from "./modules/live-chat/match-watcher.js";
import riskzillaRoutes from "./modules/admin/riskzilla/routes.js";
import zillapassUserRoutes from "./modules/zillapass/routes.js";
import adminZillapassRoutes from "./modules/admin/zillapass.js";
import { startPushOutboxWorker, type PushWorkerHandle } from "./modules/push/worker.js";
import { ApiError } from "./lib/errors.js";

const env = loadEnv();
const auth = loadAuthEnv();
const startedAt = Date.now();

// X-Request-ID accepted from upstream callers (browser, Caddy, Next.js
// SSR via lib/server-fetch.ts) is echoed onto every log line and the
// response header. Bound the shape so a hostile client can't poison
// log lines with newlines / control characters / huge payloads.
const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

const app = Fastify({
  logger: {
    level: env.LOG_LEVEL,
    base: { service: env.SERVICE_NAME },
    // Broad redaction so a future endpoint accepting a custom auth or
    // signature header doesn't leak secrets to journal/Loki by default.
    // The wildcard form covers x-csrf-token, x-api-key, x-signer-token,
    // etc. — anything we wouldn't want in plain log output.
    redact: [
      "req.headers.cookie",
      "req.headers.authorization",
      'req.headers["x-api-key"]',
      'req.headers["x-csrf-token"]',
      'req.headers["x-signer-token"]',
      // Defensive: no current handler logs parsed cookies, but cover
      // request.cookies + any nested .cookies shape so a future log
      // statement doesn't leak the session cookie value.
      "req.cookies",
      "*.cookies",
    ],
  },
  // Read X-Request-ID from the inbound request so a single grep finds
  // the SSR render and every API call it triggered across both log
  // streams. Pino auto-includes the resolved value as `reqId` on every
  // log line scoped to the request. Default-case generates a v4 UUID
  // (the Fastify default is an incrementing counter — useless for cross-
  // process correlation).
  genReqId: (req) => {
    const inbound = req.headers[REQUEST_ID_HEADER];
    if (typeof inbound === "string" && REQUEST_ID_SHAPE.test(inbound)) {
      return inbound;
    }
    return randomUUID();
  },
  // Single hop in front of api: Caddy. trustProxy: 1 makes Fastify
  // honour ONLY the last X-Forwarded-For entry, which Caddy appends —
  // an attacker spoofing the inbound X-Forwarded-For can't poison
  // request.ip / audit-log ip_inet because the spoofed entries are
  // dropped. trustProxy: true (the previous default) trusted the entire
  // chain, which on a single-Caddy deploy is strictly weaker.
  trustProxy: 1,
  // Default Fastify limit is 1 MiB. Most API endpoints take small JSON
  // bodies (auth: ≤512B, bets: ≤4KiB, withdrawals: ≤1KiB). Tighten the
  // floor so a slow-uploader can't stream 1 MiB into api memory on
  // every endpoint. Routes that legitimately need more (currently only
  // /admin/competitors/bulk-logos at ~200 KiB) override via route
  // config { bodyLimit: ... }. Caddy already caps at 1 MiB; this is
  // belt + suspenders.
  bodyLimit: 64 * 1024,
  disableRequestLogging: false,
});

// ─── Global plugins ─────────────────────────────────────────────────────────

// JSON-only API surface. Lock CSP down to the bare minimum — the API
// never serves HTML, frames, scripts, or fonts, so `default-src 'none'`
// plus `frame-ancestors 'none'` is sufficient.
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
});
await app.register(cookie, { secret: auth.refreshCookieSecret });
await app.register(cors, {
  origin: corsOrigins(env),
  credentials: true,
});
await app.register(rateLimit, {
  global: false, // opt-in per route via config.rateLimit
  // In-memory store for MVP; swap to Redis store in phase 4 when we have
  // more than one api container.
});

// ─── Decorators ─────────────────────────────────────────────────────────────

await app.register(dbPlugin, { databaseUrl: env.DATABASE_URL });
await app.register(redisPlugin, { redisUrl: env.REDIS_URL });
await app.register(authPlugin, { auth });
await app.register(csrfPlugin, { allowedOrigins: corsOrigins(env) });

// Echo the resolved request id on the response so the browser dev-tools
// network tab + any client-side log line can quote it back to support.
// Running BEFORE the response is sent (onSend) is important — onResponse
// fires too late to add headers.
app.addHook("onSend", async (request, reply) => {
  reply.header(REQUEST_ID_HEADER, request.id);
});

// ─── Error handler ──────────────────────────────────────────────────────────

app.setErrorHandler((err: FastifyError | ApiError | ZodError, request, reply) => {
  if (err instanceof ZodError) {
    reply.code(400).send({
      error: "validation_error",
      message: "Invalid request payload",
      issues: err.issues.map((i) => ({
        path: i.path.join("."),
        code: i.code,
        message: i.message,
      })),
    });
    return;
  }
  if (err instanceof ApiError) {
    reply.code(err.statusCode).send({ error: err.code, message: err.message });
    return;
  }
  // Never leak internals. Log with stack, respond with a generic message.
  request.log.error({ err }, "unhandled error");
  const fe = err as FastifyError;
  const status = typeof fe.statusCode === "number" ? fe.statusCode : 500;
  reply.code(status).send({
    error: status === 500 ? "internal_error" : "error",
    message: status === 500 ? "Something went wrong" : fe.message,
  });
});

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get("/healthz", async (): Promise<HealthResponse> => {
  const [dbOk, redisOk] = await Promise.all([
    app.sql`SELECT 1 AS ok`.then(() => true).catch(() => false),
    app.redis
      .ping()
      .then((r) => r === "PONG")
      .catch(() => false),
  ]);
  const ok = dbOk && redisOk;
  return {
    status: ok ? "ok" : "degraded",
    db: dbOk ? "ok" : "down",
    redis: redisOk ? "ok" : "down",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    version: process.env.GIT_SHA ?? "dev",
  };
});

await app.register(authRoutes);
await app.register(usersRoutes);
await app.register(walletRoutes);
await app.register(catalogRoutes);
await app.register(betsRoutes);
await app.register(cashoutRoutes);
await app.register(adminRoutes);
await app.register(oddsConfigRoutes);
await app.register(combiBoostConfigRoutes);
await app.register(zillaflashConfigRoutes);
await app.register(adminSportsRoutes);
await app.register(adminCashoutConfigRoutes);
await app.register(betProductsRoutes);
await app.register(adminTicketsRoutes);
await app.register(adminWithdrawalsRoutes);
await app.register(adminDepositsRoutes);
await app.register(adminDashboardRoutes);
await app.register(adminUsersRoutes);
await app.register(adminAuditRoutes);
await app.register(adminFeedRoutes);
await app.register(adminWedgedMatchesRoutes);
await app.register(adminLogsRoutes);
await app.register(adminFeSettingsRoutes);
await app.register(adminCompetitorsRoutes);
await app.register(adminTournamentsRoutes);
await app.register(adminMonitoringRoutes);
await app.register(adminDeployRoutes);
await app.register(communityRoutes);
await app.register(communityAvatarRoutes);
await app.register(communityAnalysesRoutes);
await app.register(communityCompetitionsRoutes);
await app.register(communityNotificationsRoutes);
await app.register(adminCommunityRoutes);
await app.register(adminCompetitionsRoutes);
await app.register(adminAvatarRoutes);
await app.register(widgetsRoutes);
await app.register(betbuilderRoutes);
await app.register(zillatipsRoutes);
await app.register(zillafactsRoutes);
await app.register(zillaflashRoutes);
await app.register(devicesRoutes);
await app.register(liveChatRoutes);
await app.register(riskzillaRoutes);
await app.register(zillapassUserRoutes);
await app.register(adminZillapassRoutes);

app.get("/", async () => ({ service: "oddzilla-api", status: "ok" }));

// ─── Background workers ─────────────────────────────────────────────────────

// Live-chat match-state watcher. Subscribes to odds:match:* and emits
// goal / full-time / cancelled system messages into rooms with active
// viewers. Set LIVE_CHAT_WATCHER_DISABLED=1 to skip — useful for
// per-instance debugging or future multi-process deployments where
// only one container should own the emission path.
let matchWatcherHandle: { close: () => Promise<void> } | null = null;
if (process.env.LIVE_CHAT_WATCHER_DISABLED !== "1") {
  matchWatcherHandle = await startMatchWatcher(app, { redisUrl: env.REDIS_URL });
}

// Push-notification outbox drainer. Subscribes via postgres LISTEN to
// the `push_outbox` channel (fired by services/settlement on winning
// ticket commits) and dispatches via Firebase Admin SDK. When
// FIREBASE_SERVICE_ACCOUNT_PATH / GOOGLE_APPLICATION_CREDENTIALS is
// unset the worker still runs but marks rows with last_error=
// 'firebase_disabled' so the table doesn't grow unbounded. Set
// PUSH_OUTBOX_WORKER_DISABLED=1 to skip entirely (for future
// multi-instance deploys where only one container should drain).
let pushWorkerHandle: PushWorkerHandle | null = null;
if (process.env.PUSH_OUTBOX_WORKER_DISABLED !== "1") {
  pushWorkerHandle = await startPushOutboxWorker(app);
}

// ─── Boot ───────────────────────────────────────────────────────────────────

app
  .listen({ port: env.API_PORT, host: "0.0.0.0" })
  .then(() => app.log.info({ port: env.API_PORT }, "api listening"))
  .catch((err) => {
    app.log.error(err, "failed to start");
    process.exit(1);
  });

// Background monitoring sampler — fires every 60s, lock-guarded so a
// future multi-instance api deploy still produces one sample per
// minute. Returns a stop fn that the SIGTERM handler calls so the
// timer doesn't keep the event loop alive past app.close().
const stopMonitoringSampler = startMonitoringSampler(app);

// ZillaFlash offer rotation. Runs in-process: keeps 2 prematch + 2
// live boosted offers warm, picks replacements from the eligible pool
// (Tier 1-3 matches × per-sport `top` markets) when an offer's TTL
// elapses (60 s prematch / 15 s live). Stop fn clears the rotation
// timer so api shutdown doesn't dangle.
const stopZillaFlashRotation = startZillaFlashRotation(app);

async function shutdown() {
  app.log.info("shutting down");
  stopMonitoringSampler();
  stopZillaFlashRotation();
  if (matchWatcherHandle) {
    try {
      await matchWatcherHandle.close();
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, "watcher shutdown error");
    }
  }
  if (pushWorkerHandle) {
    try {
      await pushWorkerHandle.close();
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, "push worker shutdown error");
    }
  }
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
