// logo-store.ts
//
// Download-and-store helpers for team logos. Used by
// `resolve-oddin-icons.ts`, which is the only resolver — Oddin's
// /v1/sports/{lang}/competitors/{urn}/profile already returns
// `icon_path` for every competitor in the feed and feed-ingester
// caches it into `competitor_profiles.icon_path`. We don't need a
// fallback source: any team Oddin sends us has a logo URL there,
// and any team Oddin doesn't send us isn't on the storefront.

import { mkdir, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

const REQUEST_HEADERS = {
  "User-Agent":
    "OddzillaLogoResolver/1.0 (https://oddzilla.cc; admin contact via repo)",
  "Accept-Encoding": "gzip",
  Accept: "image/*",
};

// Cooperative 429 window per host. cdn.oddin.gg has never rate-limited
// us in practice (we're an authenticated customer), but the backoff
// keeps us polite if a future source ever 429s — and lets a single
// 429 from any one origin pause only that origin's workers.
const backoffByHost = new Map<string, number>();

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function tripBackoffFor(host: string, seconds: number): void {
  const target = Date.now() + seconds * 1000;
  const existing = backoffByHost.get(host) ?? 0;
  if (target > existing) backoffByHost.set(host, target);
}

async function respectBackoffFor(host: string): Promise<void> {
  const until = backoffByHost.get(host) ?? 0;
  const now = Date.now();
  if (now < until) {
    await new Promise((r) => setTimeout(r, until - now));
  }
}

export async function ensureStoreDir(storeDir: string): Promise<void> {
  await mkdir(storeDir, { recursive: true });
  await access(storeDir, fsConstants.W_OK);
}

// Download `remoteUrl` and write it to `{storeDir}/{competitorId}.{ext}`.
// Returns the public path (`/team-logos/{competitorId}.{ext}`) on
// success or null on 4xx/5xx/empty body. Pre-existing files for that
// competitor are overwritten so re-running the resolver picks up logo
// refreshes from Oddin's CDN.
export async function downloadAndStore(
  remoteUrl: string,
  competitorId: number,
  storeDir: string,
): Promise<string | null> {
  const host = hostOf(remoteUrl);
  await respectBackoffFor(host);
  const res = await fetch(remoteUrl, { headers: REQUEST_HEADERS });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    tripBackoffFor(host, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30);
    return null;
  }
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) return null;

  // Pick the file extension from Content-Type with the URL suffix as a
  // fallback. Keeping the extension truthful matters because Caddy
  // serves these with their on-disk name and the browser sniffs from
  // there for `Content-Type` on cache hits.
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  let ext = "png";
  if (ct.startsWith("image/png")) ext = "png";
  else if (ct.startsWith("image/jpeg")) ext = "jpg";
  else if (ct.startsWith("image/svg")) ext = "svg";
  else if (ct.startsWith("image/webp")) ext = "webp";
  else if (ct.startsWith("image/gif")) ext = "gif";
  else {
    const urlExtMatch = remoteUrl.match(/\.([a-z0-9]{2,5})(?:\?|#|$)/i);
    if (urlExtMatch?.[1]) ext = urlExtMatch[1].toLowerCase();
  }

  const filename = `${competitorId}.${ext}`;
  await writeFile(join(storeDir, filename), buf);
  return `/team-logos/${filename}`;
}
