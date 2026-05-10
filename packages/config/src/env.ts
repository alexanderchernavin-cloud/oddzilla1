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

  // Empty string means "same origin" — used in prod where Caddy fronts both
  // hosts and the browser should call relative /api and /ws paths.
  NEXT_PUBLIC_API_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().optional(),
  ),
  NEXT_PUBLIC_WS_URL: z.string().optional(),

  // Oddin Disir widgets (services/api). Empty token = widget routes
  // return 503 widget_disabled and the storefront silently skips
  // rendering the iframes.
  DISIR_BASE_URL: z.string().url().default("https://api-disir.oddin.gg"),
  DISIR_BRAND_TOKEN: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(8).optional(),
  ),
  DISIR_ENV: z.enum(["integration", "main"]).default("integration"),

  // Oddin BetBuilder (OBB) gRPC client (services/api). Same graceful-idle
  // pattern as Disir: when host is empty, /betbuilder/* returns 503
  // betbuilder_disabled and the storefront hides the toggle. Production:
  //   ODDIN_OBB_HOST=api-obb.oddin.gg:443
  //   ODDIN_OBB_TLS=true
  // Integration:
  //   ODDIN_OBB_HOST=api-obb.integration.oddin.gg:443
  //   ODDIN_OBB_TLS=true
  // Token is the same Oddin access token used elsewhere (the OBB API
  // accepts it via per-RPC `token` metadata key). Defaults to the main
  // ODDIN_TOKEN when ODDIN_OBB_TOKEN is unset, so a single secret covers
  // both surfaces; override only if Oddin issues a separate OBB token.
  ODDIN_OBB_HOST: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(3).optional(),
  ),
  ODDIN_OBB_TLS: z
    .preprocess((v) => (typeof v === "string" ? v.toLowerCase() : v), z.enum(["true", "false"]))
    .default("true"),
  ODDIN_TOKEN: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(8).optional(),
  ),
  ODDIN_OBB_TOKEN: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(8).optional(),
  ),

  // Single shared ERC20 receive address for USDC deposits. Empty =
  // /wallet/deposit-address returns { available: false } and the
  // storefront tells the user deposits aren't currently enabled.
  // Empty string folds to undefined so `.optional()` accepts the
  // unset case — matches the ODDIN_* preprocessors above and lets
  // .env.example ship the field blank without breaking boot.
  DEPOSIT_RECEIVE_ADDRESS: z.preprocess(
    (v) => {
      if (typeof v !== "string") return v;
      const trimmed = v.trim();
      return trimmed === "" ? undefined : trimmed;
    },
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/u, "DEPOSIT_RECEIVE_ADDRESS must be a 0x-prefixed 40-hex address")
      .optional(),
  ),

  // Metrics-collector base URL (services/metrics-collector). Default
  // resolves the compose service name on the docker default network.
  // When unreachable the /admin/monitoring page surfaces "metrics
  // unavailable" rather than crashing — same graceful-idle pattern
  // Disir / OBB use.
  METRICS_COLLECTOR_URL: z.string().url().default("http://metrics-collector:9090"),
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
