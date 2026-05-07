import type { NextConfig } from "next";

// Empty string defaults. Next.js bakes NEXT_PUBLIC_* at build time, and the
// container build step does NOT have access to .env (that's only loaded at
// runtime via env_file in docker-compose). Previously the fallback baked
// `http://localhost:3001` into the production bundle, which the browser
// then tried to hit and fetch threw "Failed to fetch".
//
// With empty string here:
//   - prod: api-client resolves empty → "/api" → Caddy proxy → api:3001 ✓
//   - prod: ws-client resolves empty → `wss://<current-host>/ws` → ws-gateway ✓
//   - dev: developers put real values in apps/web/.env.local (Next.js reads
//     that automatically) so local pnpm dev keeps working.

// Build-time guard against the recurring regression where a non-empty
// localhost URL gets baked into the production bundle. If NODE_ENV is
// `production` and either var contains `localhost` / `127.0.0.1`, fail
// the build loudly instead of producing a broken artifact.
function assertProdSafePublicEnv(): void {
  if (process.env.NODE_ENV !== "production") return;
  for (const key of ["NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_WS_URL"] as const) {
    const v = process.env[key] ?? "";
    if (/(localhost|127\.0\.0\.1)/.test(v)) {
      throw new Error(
        `${key}=${v} would bake a localhost URL into the production bundle. ` +
          `Leave it empty in prod so the browser falls back to same-origin.`,
      );
    }
  }
}
assertProdSafePublicEnv();

const config: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@oddzilla/types"],
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "",
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL ?? "",
  },
  // Dev-only rewrite mirroring what Caddy does in prod: any browser
  // request that lands on `/api/*` is forwarded to the local api
  // server with the prefix stripped. Without this, server-baked URLs
  // like `/api/community/avatars/<slug>/image` (which the api emits
  // because that's the prod path) 404 against the Next dev server.
  // In production this function returns an empty array so Caddy stays
  // the only routing surface — assertProdSafePublicEnv above already
  // guards against bundle-time leaks.
  async rewrites() {
    if (process.env.NODE_ENV === "production") return [];
    const apiOrigin = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
    return [
      {
        source: "/api/:path*",
        destination: `${apiOrigin}/:path*`,
      },
    ];
  },
};

export default config;
