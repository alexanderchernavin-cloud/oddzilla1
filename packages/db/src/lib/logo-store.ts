// logo-store.ts
//
// Shared download-and-store helpers for team logos. Used by:
//   - resolve-logos.ts        (Liquipedia og:image scrape pipeline)
//   - apply-logo-seed-direct.ts (curated seed overrides)
//   - localize-logos.ts       (one-shot fix-up of pre-volume http URLs)
//
// Why a single helper: every callsite needs the same content-type → ext
// mapping, the same idempotency rule (existing file on disk is reused),
// and the same Liquipedia 429 backoff. Three copies of that logic would
// drift the moment Liquipedia adds a new MIME or tightens rate limits.

import { mkdir, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

const REQUEST_HEADERS = {
  "User-Agent":
    "OddzillaLogoResolver/1.0 (https://oddzilla.cc; admin contact via repo)",
  "Accept-Encoding": "gzip",
  Accept: "image/*",
};

// Cooperative 429 window. Once any caller observes a Liquipedia 429,
// every subsequent fetch via this module pauses until `backoffUntil`.
let backoffUntil = 0;

export function tripBackoff(seconds: number): void {
  const target = Date.now() + seconds * 1000;
  if (target > backoffUntil) backoffUntil = target;
}

export async function respectBackoff(): Promise<void> {
  const now = Date.now();
  if (now < backoffUntil) {
    await new Promise((r) => setTimeout(r, backoffUntil - now));
  }
}

export async function ensureStoreDir(storeDir: string): Promise<void> {
  await mkdir(storeDir, { recursive: true });
  await access(storeDir, fsConstants.W_OK);
}

// Download `remoteUrl` and write it to `{storeDir}/{competitorId}.{ext}`.
// Returns the public path (`/team-logos/{competitorId}.{ext}`) on success
// or null on 4xx/5xx/empty body. Pre-existing files for that competitor
// are not touched — re-runs are idempotent. Pass --force in the calling
// script to delete first if you really want to refresh.
export async function downloadAndStore(
  remoteUrl: string,
  competitorId: number,
  storeDir: string,
): Promise<string | null> {
  await respectBackoff();
  const res = await fetch(remoteUrl, { headers: REQUEST_HEADERS });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    tripBackoff(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30);
    return null;
  }
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) return null;

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

// Convenience: "is this already a self-hosted local path?" — used by the
// localizer to skip rows that are already correct.
export function isLocalPath(url: string): boolean {
  return url.startsWith("/team-logos/");
}
