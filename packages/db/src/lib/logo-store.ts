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

// ─── Wikipedia source ───────────────────────────────────────────────
//
// Used as a primary source when Liquipedia's IP block is in effect, or
// as a parallel-source for famous teams (Wikipedia covers Tier-1 orgs
// like T1, FaZe, NaVi, Liquid, Fnatic, G2 with high-quality `og:image`
// from Wikimedia Commons; coverage drops sharply for tier-2/3 and
// regional teams). Wikipedia's API rate limits are friendlier than
// Liquipedia's — they explicitly invite API usage with a polite UA.
//
// Pipeline:
//   1. opensearch finds the article title closest to the team name
//   2. action=query?prop=pageimages|categories returns the og:image-
//      equivalent `original` URL plus categories (so we can sanity-check
//      that we matched an esports / video-game-team article rather than
//      e.g. the Albanian football club called "Liquid")
//
// Returns null when no candidate article exists, the article isn't an
// esports team, or it has no main image.

const WIKIPEDIA_UA =
  "OddzillaLogoResolver/1.0 (https://oddzilla.cc; admin@oddzilla.cc)";

// Substrings any one of which in the article's category list marks it
// as an esports team. Lowercased; matched as substring so both
// "Esports teams established in 2003" and
// "Counter-Strike clan" hit. We deliberately keep the list short — false
// negatives are fine (we just skip), false positives risk pulling the
// wrong logo onto a team row.
const ESPORTS_CATEGORY_HINTS = [
  "esports team",
  "esports clan",
  "esports organization",
  "esports organisation",
  "video game team",
  "video gaming clan",
  "counter-strike",
  "dota 2",
  "league of legends",
  "valorant",
  "starcraft",
  "rainbow six",
  "rocket league",
  "mobile legends",
  "honor of kings",
  "arena of valor",
  "overwatch",
  "warcraft",
  "professional gaming",
];

function matchesEsportsCategory(categories: string[]): boolean {
  for (const c of categories) {
    const lower = c.toLowerCase();
    for (const hint of ESPORTS_CATEGORY_HINTS) {
      if (lower.includes(hint)) return true;
    }
  }
  return false;
}

// Wikipedia opensearch returns ["query", titles[], descs[], urls[]]
// where index 0 (if any) is the closest-matching article title. We only
// care about the first hit — the resolver burns through too many teams
// to backtrack.
async function wikipediaTopTitle(name: string): Promise<string | null> {
  await respectBackoff();
  const url =
    "https://en.wikipedia.org/w/api.php?" +
    new URLSearchParams({
      action: "opensearch",
      format: "json",
      search: name,
      limit: "1",
      namespace: "0",
    }).toString();
  const res = await fetch(url, {
    headers: { "User-Agent": WIKIPEDIA_UA, Accept: "application/json" },
  });
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    tripBackoff(Number.isFinite(ra) && ra > 0 ? ra : 30);
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body) || !Array.isArray(body[1])) return null;
  const titles = body[1] as string[];
  return titles[0] ?? null;
}

interface WikipediaPage {
  title?: string;
  missing?: string;
  original?: { source: string };
  pageprops?: { page_image?: string; "page_image_free"?: string };
  categories?: Array<{ title: string }>;
}

// Lookup pageimages + pageprops + categories for an exact title.
// Returns null on 429 / non-2xx / network errors. We ask for both
// pageimages.original AND pageprops.page_image because the
// pageimages extension's `original` field is unpopulated for many
// older articles (the indexer only refreshes on page edits) — but
// pageprops.page_image is the file name set by the {{infobox}}
// template so it's reliable. Caller decides which to use.
async function wikipediaPage(title: string): Promise<WikipediaPage | null> {
  await respectBackoff();
  const url =
    "https://en.wikipedia.org/w/api.php?" +
    new URLSearchParams({
      action: "query",
      format: "json",
      titles: title,
      prop: "pageimages|pageprops|categories",
      piprop: "original",
      cllimit: "50",
      redirects: "1",
    }).toString();
  const res = await fetch(url, {
    headers: { "User-Agent": WIKIPEDIA_UA, Accept: "application/json" },
  });
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    tripBackoff(Number.isFinite(ra) && ra > 0 ? ra : 30);
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json()) as {
    query?: { pages?: Record<string, WikipediaPage> };
  };
  const pages = body.query?.pages ?? {};
  return Object.values(pages)[0] ?? null;
}

// Resolve `File:Foo.svg` (or `Foo.svg`) to its canonical
// upload.wikimedia.org URL via the imageinfo API.
async function wikipediaFileUrl(filename: string): Promise<string | null> {
  const filePrefix = /^File:/i.test(filename) ? "" : "File:";
  await respectBackoff();
  const url =
    "https://en.wikipedia.org/w/api.php?" +
    new URLSearchParams({
      action: "query",
      format: "json",
      titles: `${filePrefix}${filename}`,
      prop: "imageinfo",
      iiprop: "url",
      iilimit: "1",
    }).toString();
  const res = await fetch(url, {
    headers: { "User-Agent": WIKIPEDIA_UA, Accept: "application/json" },
  });
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    tripBackoff(Number.isFinite(ra) && ra > 0 ? ra : 30);
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json()) as {
    query?: {
      pages?: Record<string, {
        title?: string;
        missing?: string;
        imageinfo?: Array<{ url?: string }>;
      }>;
    };
  };
  const pages = body.query?.pages ?? {};
  const page = Object.values(pages)[0];
  return page?.imageinfo?.[0]?.url ?? null;
}

// Extract the best logo URL from a Wikipedia page payload, falling
// through three sources in priority order:
//   1. pageimages.original — fast, but unpopulated for many articles
//   2. pageprops.page_image — the {{infobox}} image, almost always set
//      on team articles, but only the file *name* (needs a second API
//      call to resolve to a URL)
//   3. pageprops.page_image_free — same idea, free-licence variant
async function pickWikipediaLogo(page: WikipediaPage): Promise<string | null> {
  if (page.original?.source) return page.original.source;
  const file =
    page.pageprops?.page_image_free ?? page.pageprops?.page_image ?? null;
  if (!file) return null;
  return await wikipediaFileUrl(file);
}

// Resolve a team to a Wikipedia og:image-equivalent URL. Returns the
// raw upload.wikimedia.org image URL on success — the caller is expected
// to pass it through downloadAndStore() to localize the bytes.
//
// Strategy: try `{name} (esports)` first — that's how Wikipedia
// disambiguates e.g. "Dignitas" (which by itself is a charity / Roman
// concept disambiguation page). If the qualified title doesn't exist,
// fall back to the raw name and require an esports category tag to
// avoid grabbing a generic article's image.
export async function fetchWikipediaLogo(name: string): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  // Pass A: explicit (esports) qualifier. When this article exists,
  // its primary image is by definition the team logo, no category
  // check needed.
  const qualified = `${trimmed} (esports)`;
  const a = await wikipediaPage(qualified);
  if (a && !a.missing) {
    const url = await pickWikipediaLogo(a);
    if (url) return url;
  }

  // Pass B: raw name via opensearch (handles cases where the article
  // is just "Team Liquid" with no qualifier needed). Apply the
  // categorical filter to skip non-team matches.
  const title = await wikipediaTopTitle(trimmed);
  if (!title) return null;
  const b = await wikipediaPage(title);
  if (!b || b.missing) return null;
  const cats = (b.categories ?? []).map((c) => c.title);
  if (!matchesEsportsCategory(cats)) return null;
  return await pickWikipediaLogo(b);
}
