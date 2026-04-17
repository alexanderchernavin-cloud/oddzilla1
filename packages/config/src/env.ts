// Central env parsing. Every TS service imports `loadEnv()` exactly once at
// boot. Fails fast with a clear error if anything required is missing.
//
// Secrets are marked optional here so services that don't need them (e.g.
// ws-gateway) can boot with `loadEnv()` alone. Services that need them
// (services/api, apps/web server components) call `loadAuthEnv()` which
// enforces presence.

import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  SERVICE_NAME: z.string().default("unknown"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_SECRET: z.string().min(32).optional(),
  REFRESH_COOKIE_SECRET: z.string().min(32).optional(),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

  API_PORT: z.coerce.number().int().positive().default(3001),
  WS_GATEWAY_PORT: z.coerce.number().int().positive().default(3002),
  WEB_PORT: z.coerce.number().int().positive().default(3000),

  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  COOKIE_DOMAIN: z.string().optional(),

  NEXT_PUBLIC_API_URL: z.string().url().optional(),
  NEXT_PUBLIC_WS_URL: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.error(`[config] invalid environment:\n${issues}`);
    process.exit(1);
  }
  cached = result.data;
  return cached;
}

export interface AuthEnv {
  jwtSecret: string;
  refreshCookieSecret: string;
  jwtAccessTtlSeconds: number;
  refreshTtlDays: number;
  cookieDomain: string | undefined;
  isProduction: boolean;
}

/** Loads and enforces auth-required env. Call from services that sign/verify JWTs. */
export function loadAuthEnv(): AuthEnv {
  const env = loadEnv();
  if (!env.JWT_SECRET || !env.REFRESH_COOKIE_SECRET) {
    // eslint-disable-next-line no-console
    console.error(
      "[config] JWT_SECRET and REFRESH_COOKIE_SECRET are required for this service. " +
        "Generate with: openssl rand -base64 48",
    );
    process.exit(1);
  }
  return {
    jwtSecret: env.JWT_SECRET,
    refreshCookieSecret: env.REFRESH_COOKIE_SECRET,
    jwtAccessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
    refreshTtlDays: env.REFRESH_TTL_DAYS,
    cookieDomain: env.COOKIE_DOMAIN,
    isProduction: env.NODE_ENV === "production",
  };
}

export function corsOrigins(env: Env = loadEnv()): string[] {
  return env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
}
