// Fastify REST API. Boots, registers plugins + routes, serves /healthz.
// Route surface: /auth, /users, /wallet, /catalog, /admin (role-gated).

import Fastify, { type FastifyError } from "fastify";
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
import authRoutes from "./modules/auth/routes.js";
import usersRoutes from "./modules/users/routes.js";
import walletRoutes from "./modules/wallet/routes.js";
import catalogRoutes from "./modules/catalog/routes.js";
import betsRoutes from "./modules/bets/routes.js";
import cashoutRoutes from "./modules/cashout/routes.js";
import adminRoutes from "./modules/admin/routes.js";
import oddsConfigRoutes from "./modules/admin/odds-config.js";
import adminCashoutConfigRoutes from "./modules/admin/cashout-config.js";
import betProductsRoutes from "./modules/admin/bet-products.js";
import adminTicketsRoutes from "./modules/admin/tickets.js";
import adminWithdrawalsRoutes from "./modules/admin/withdrawals.js";
import adminDashboardRoutes from "./modules/admin/dashboard.js";
import adminUsersRoutes from "./modules/admin/users.js";
import adminAuditRoutes from "./modules/admin/audit.js";
import adminFeedRoutes from "./modules/admin/feed.js";
import adminLogsRoutes from "./modules/admin/logs.js";
import adminFeSettingsRoutes from "./modules/admin/fe-settings.js";
import adminCompetitorsRoutes from "./modules/admin/competitors.js";
import { ApiError } from "./lib/errors.js";

const env = loadEnv();
const auth = loadAuthEnv();
const startedAt = Date.now();

const app = Fastify({
  logger: {
    level: env.LOG_LEVEL,
    base: { service: env.SERVICE_NAME },
    redact: ["req.headers.cookie", "req.headers.authorization"],
  },
  trustProxy: true,
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
await app.register(adminCashoutConfigRoutes);
await app.register(betProductsRoutes);
await app.register(adminTicketsRoutes);
await app.register(adminWithdrawalsRoutes);
await app.register(adminDashboardRoutes);
await app.register(adminUsersRoutes);
await app.register(adminAuditRoutes);
await app.register(adminFeedRoutes);
await app.register(adminLogsRoutes);
await app.register(adminFeSettingsRoutes);
await app.register(adminCompetitorsRoutes);

app.get("/", async () => ({ service: "oddzilla-api", status: "ok" }));

// ─── Boot ───────────────────────────────────────────────────────────────────

app
  .listen({ port: env.API_PORT, host: "0.0.0.0" })
  .then(() => app.log.info({ port: env.API_PORT }, "api listening"))
  .catch((err) => {
    app.log.error(err, "failed to start");
    process.exit(1);
  });

async function shutdown() {
  app.log.info("shutting down");
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
