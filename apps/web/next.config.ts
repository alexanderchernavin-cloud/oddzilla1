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
const config: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@oddzilla/types"],
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "",
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL ?? "",
  },
};

export default config;
