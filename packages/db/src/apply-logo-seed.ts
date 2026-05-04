// apply-logo-seed.ts
//
// Bulk-apply curated team logo URLs from packages/db/seeds/competitor-logos.json
// via the /admin/competitors/bulk-logos endpoint. The endpoint matches each
// entry by (sport_slug, competitor_slug) and is idempotent — re-running
// after a feed delivers more teams just fills in the new ones.
//
// Usage:
//   ADMIN_EMAIL=admin@oddzilla.local \
//   ADMIN_PASSWORD=ChangeMeAdmin123! \
//   API_BASE_URL=http://localhost:3001 \
//     pnpm --filter @oddzilla/db tsx src/apply-logo-seed.ts
//
// API_BASE_URL defaults to http://localhost:3001 (dev). On the prod server
// run from inside the docker network: API_BASE_URL=http://api:3001.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

interface SeedFile {
  entries: Array<{
    sportSlug: string;
    competitorSlug: string;
    logoUrl: string | null;
    brandColor?: string | null;
  }>;
}

interface BulkResponse {
  updatedCount: number;
  missingCount: number;
  updated: Array<{ sportSlug: string; competitorSlug: string }>;
  missing: Array<{ sportSlug: string; competitorSlug: string; reason: string }>;
}

interface AuthResponse {
  user: { id: string; email: string; role: string };
  accessTokenExpiresAt: string;
}

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const apiBase = process.env.API_BASE_URL ?? "http://localhost:3001";

  if (!adminEmail || !adminPassword) {
    console.error("ADMIN_EMAIL and ADMIN_PASSWORD env vars are required");
    process.exit(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const seedPath = resolve(here, "..", "seeds", "competitor-logos.json");
  const seed = JSON.parse(readFileSync(seedPath, "utf8")) as SeedFile;
  console.log(`loaded ${seed.entries.length} logo entries from ${seedPath}`);

  // 1. Login to get the access cookie. We capture Set-Cookie and forward
  // it on the bulk request — undici's fetch doesn't share a cookie jar
  // across calls.
  const loginRes = await fetch(`${apiBase}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  });
  if (!loginRes.ok) {
    console.error(`login failed: ${loginRes.status} ${await loginRes.text()}`);
    process.exit(1);
  }
  const loginBody = (await loginRes.json()) as AuthResponse;
  if (loginBody.user.role !== "admin") {
    console.error(
      `account ${loginBody.user.email} has role=${loginBody.user.role}, need admin`,
    );
    process.exit(1);
  }
  const cookies = parseSetCookie(loginRes.headers);

  // 2. Hit the bulk endpoint.
  const res = await fetch(`${apiBase}/admin/competitors/bulk-logos`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      cookie: cookies,
    },
    body: JSON.stringify({ entries: seed.entries }),
  });
  if (!res.ok) {
    console.error(`bulk-logos failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const body = (await res.json()) as BulkResponse;
  console.log(`updated ${body.updatedCount} competitors`);
  if (body.missingCount > 0) {
    console.warn(`missing ${body.missingCount} (no matching team in DB):`);
    for (const m of body.missing) {
      console.warn(`  ${m.sportSlug}/${m.competitorSlug} — ${m.reason}`);
    }
  }
}

function parseSetCookie(h: Headers): string {
  // Node's fetch exposes the cookie list via getSetCookie() per WHATWG.
  const list = (h as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (list && list.length) {
    return list.map((c) => c.split(";")[0]).join("; ");
  }
  // Fallback for older runtimes that only expose a flattened header.
  const single = h.get("set-cookie");
  return single ? single.split(",").map((c) => c.split(";")[0]).join("; ") : "";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
