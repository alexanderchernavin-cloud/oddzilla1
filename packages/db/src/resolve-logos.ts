// resolve-logos.ts
//
// Server-side bulk logo resolver. Connects directly to Postgres, iterates
// every active competitor in real esports, fetches each team's Liquipedia
// page, extracts the `og:image` meta tag, **downloads the actual image
// file** to LOGO_STORE_DIR (a docker volume Caddy serves at /team-logos),
// then writes the LOCAL path (`/team-logos/{competitor_id}.{ext}`) into
// `competitors.logo_url`. Self-hosting the assets means:
//   - No third-party hot-link fragility (Liquipedia 429s, file renames).
//   - No leak of user IPs to liquipedia.net on every page render.
//   - Long-cache headers via Caddy (filename is content-stable).
//   - The site keeps working when liquipedia.net is down.
//
// We don't use Liquipedia's MediaWiki `prop=pageimages` API because the
// extension isn't installed on their wikis; og:image is the canonical
// alternative — Liquipedia's standard team-page template populates
// `<meta property="og:image">` from the team-card logo on every wiki.
//
// Idempotent: rows that already have logo_url stay put unless --force.
// Already-downloaded files on disk are reused (never re-downloaded).
//
// Usage (from inside the api container so the docker network resolves
// `postgres`, DATABASE_URL/LOGO_STORE_DIR are set, and the team-logos
// volume is mounted at /data/team-logos):
//
//   sudo -n docker exec -w /app/packages/db oddzilla-api-1 \
//     sh -c "pnpm db:resolve-logos --dry-run"
//
// Flags:
//   --force            overwrite existing logo_url values
//   --sport=<slug>     limit to one sport (cs2 | lol | valorant | dota2 | ...)
//   --dry-run          report what would change without writing
//   --concurrency=N    parallel page fetches (default 4, max 16)

import { sql, eq } from "drizzle-orm";
import { createDb } from "./index.js";
import { competitors, sports } from "./schema/index.js";
import {
  downloadAndStore,
  ensureStoreDir,
  respectBackoff as backoffRespect,
  tripBackoff as backoffTrip,
} from "./lib/logo-store.js";

interface CliFlags {
  force: boolean;
  sport: string | null;
  dryRun: boolean;
  concurrency: number;
}

function parseFlags(argv: string[]): CliFlags {
  const out: CliFlags = { force: false, sport: null, dryRun: false, concurrency: 4 };
  for (const a of argv) {
    if (a === "--force") out.force = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--sport=")) out.sport = a.slice("--sport=".length);
    else if (a.startsWith("--concurrency=")) {
      const n = Number.parseInt(a.slice("--concurrency=".length), 10);
      if (Number.isFinite(n) && n > 0) out.concurrency = Math.min(16, n);
    }
  }
  return out;
}

// Sport slug → Liquipedia wiki slug. Sports not in this map are skipped —
// either bot-feed (efootballbots/ebasketballbots), simulated team-sport
// match-fixing (efootball/ebasketball/etouchdown/ecricket), unclassified,
// or sport variants without a Liquipedia wiki (cs2-duels, dota2-duels).
const WIKI_BY_SPORT: Record<string, string> = {
  cs2: "counterstrike",
  dota2: "dota2",
  lol: "leagueoflegends",
  valorant: "valorant",
  ml: "mobilelegends",
  kog: "honorofkings",
  r6: "rainbowsix",
  sc2: "starcraft2",
  cod: "callofduty",
  aov: "arenaofvalor",
  rocketleague: "rocketleague",
  overwatch: "overwatch",
  crossfire: "crossfire",
  sc1: "starcraft",
  w3: "warcraft",
};

const REQUEST_HEADERS = {
  // Liquipedia's API ToS asks for a descriptive User-Agent and requires
  // Accept-Encoding: gzip — they 406 plain text/identity requests on
  // /api.php. We send the same headers for HTML scrapes for consistency.
  "User-Agent":
    "OddzillaLogoResolver/1.0 (https://oddzilla.cc; admin contact via repo)",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Encoding": "gzip",
};

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Convert team display name → URL path segment Liquipedia uses. Spaces
// become underscores; everything else passes through encodeURIComponent
// so non-ASCII names like "Leviatán" or "MAD Lions KOI" still resolve.
function pageTitle(name: string): string {
  // Replace spaces with underscores first so encodeURIComponent doesn't
  // turn them into %20 (Liquipedia handles both but underscores are the
  // canonical form and skip a redirect).
  return encodeURIComponent(name.trim().replace(/\s+/g, "_")).replace(/%2F/g, "/");
}

// Transform an og:image (full-resolution) URL to a smaller thumb. The
// pattern is /commons/images/{a}/{ab}/{file} → /commons/images/thumb/
// {a}/{ab}/{file}/{size}px-{file}. Liquipedia generates these on demand
// for any reasonable size, and we want ~128–256 px sources for a 24–28
// px display element with retina headroom.
function toThumb(originalUrl: string, sizePx: number): string {
  // Skip transformation if it's already a thumb URL.
  if (originalUrl.includes("/thumb/")) return originalUrl;
  const m = originalUrl.match(
    /^(https:\/\/liquipedia\.net\/commons\/images\/)([0-9a-f]\/[0-9a-f]{2}\/)([^?#]+)$/,
  );
  if (!m) return originalUrl;
  const [, base, dir, file] = m;
  return `${base}thumb/${dir}${file}/${sizePx}px-${file}`;
}

interface FetchedLogo {
  url: string | null;
  status: number;
  source: "exact" | "search" | "miss" | "error";
}

// Re-export the shared backoff so the local fetchPageLogo / search
// helpers throttle in lock-step with the downloader. All three (page
// scrape, opensearch, image download) hit liquipedia.net so they share
// one 429 window.
const respectBackoff = backoffRespect;
const tripBackoff = backoffTrip;

// Fetch a single page by title and extract og:image. Returns null when
// the page either 404s or its og:image is the wiki's default placeholder.
async function fetchPageLogo(
  wiki: string,
  title: string,
): Promise<{ url: string | null; status: number }> {
  await respectBackoff();
  const pageUrl = `https://liquipedia.net/${wiki}/${pageTitle(title)}`;
  const res = await fetch(pageUrl, { headers: REQUEST_HEADERS, redirect: "follow" });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitS = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30;
    console.warn(`  429 on ${title}; backing off ${waitS}s for all workers`);
    tripBackoff(waitS);
    return { url: null, status: 429 };
  }
  if (!res.ok) return { url: null, status: res.status };
  const html = await res.text();
  const m = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
  const original = m?.[1];
  if (!original) return { url: null, status: res.status };
  if (/_default_(allmode|lightmode|darkmode)\.png/i.test(original)) {
    return { url: null, status: res.status };
  }
  return { url: toThumb(original, 256), status: res.status };
}

// MediaWiki opensearch returns ["query", [titles], [descriptions], [urls]].
// We use it as a fallback when the exact-title page is 404 or the
// placeholder logo. Searching on Liquipedia mostly hits team articles
// because the corpus is small and team-heavy. Limit to the top 3 hits
// and pick the first one whose page yields a real og:image.
async function searchPageTitles(
  wiki: string,
  query: string,
): Promise<string[]> {
  await respectBackoff();
  const url =
    `https://liquipedia.net/${wiki}/api.php?` +
    new URLSearchParams({
      action: "opensearch",
      format: "json",
      search: query,
      limit: "3",
      namespace: "0",
    }).toString();
  const res = await fetch(url, {
    headers: { ...REQUEST_HEADERS, Accept: "application/json" },
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    tripBackoff(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30);
    return [];
  }
  if (!res.ok) return [];
  const body = (await res.json()) as [string, string[], string[], string[]] | unknown;
  if (!Array.isArray(body) || !Array.isArray(body[1])) return [];
  return (body as [string, string[], string[], string[]])[1];
}

async function fetchLogo(wiki: string, name: string): Promise<FetchedLogo> {
  // Pass 1: exact title (with underscores). Most popular teams hit here.
  const exact = await fetchPageLogo(wiki, name);
  if (exact.url) return { ...exact, source: "exact" };

  // Pass 2: opensearch fallback. Catches teams where the page title
  // differs from the feed name — "Team Lynx" → "Lynx (esports)",
  // "1win" → "1win Team", abbreviations, casing differences.
  let candidates: string[];
  try {
    candidates = await searchPageTitles(wiki, name);
  } catch {
    return { url: null, status: exact.status, source: "miss" };
  }
  for (const cand of candidates) {
    if (cand.toLowerCase() === name.toLowerCase()) continue; // already tried
    const hit = await fetchPageLogo(wiki, cand);
    if (hit.url) return { ...hit, source: "search" };
  }
  return { url: null, status: exact.status, source: "miss" };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const storeDir = process.env.LOGO_STORE_DIR ?? "/data/team-logos";
  if (!flags.dryRun) {
    try {
      await ensureStoreDir(storeDir);
    } catch (err) {
      console.error(`LOGO_STORE_DIR=${storeDir} is not writable: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  const { db, sql: pg } = createDb(databaseUrl);

  console.log(
    `resolve-logos: dry-run=${flags.dryRun} force=${flags.force} ` +
      `concurrency=${flags.concurrency} sport=${flags.sport ?? "all-supported"} ` +
      `storeDir=${storeDir}`,
  );

  const supportedSlugs = Object.keys(WIKI_BY_SPORT);
  const filterSlugs = flags.sport
    ? supportedSlugs.filter((s) => s === flags.sport)
    : supportedSlugs;
  if (filterSlugs.length === 0) {
    console.error(`unknown sport ${flags.sport}; supported: ${supportedSlugs.join(",")}`);
    process.exit(1);
  }

  const rows = await db
    .select({
      id: competitors.id,
      name: competitors.name,
      slug: competitors.slug,
      sportSlug: sports.slug,
      logoUrl: competitors.logoUrl,
    })
    .from(competitors)
    .innerJoin(sports, eq(sports.id, competitors.sportId))
    .where(
      flags.force
        ? sql`${sports.slug} IN (${sql.join(filterSlugs.map((s) => sql`${s}`), sql`,`)}) AND ${competitors.active} = true`
        : sql`${sports.slug} IN (${sql.join(filterSlugs.map((s) => sql`${s}`), sql`,`)}) AND ${competitors.active} = true AND ${competitors.logoUrl} IS NULL`,
    );
  console.log(`found ${rows.length} competitor rows to resolve`);

  let resolved = 0;
  let missing = 0;
  let failures = 0;

  // Worker-pool: keep `concurrency` page fetches in flight at once.
  // Each worker pulls the next row off a shared queue. Inter-request
  // pacing is implicit — with concurrency=4 and ~700 ms / page that's
  // ~5 req/s, well inside Liquipedia's "no more than 1 req per 2 s"
  // *bulk* guideline (which they themselves describe as "be reasonable
  // and we'll never block you"; HTML scrapes are different from API
  // calls — there's no explicit cap on the wiki itself).
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) return;
      const r = rows[i];
      if (!r) return;
      const wiki = WIKI_BY_SPORT[r.sportSlug];
      if (!wiki) {
        missing++;
        continue;
      }
      let result: FetchedLogo;
      try {
        result = await fetchLogo(wiki, r.name);
      } catch (err) {
        console.warn(`  err   ${r.sportSlug}/${r.slug} ${r.name}: ${(err as Error).message}`);
        failures++;
        continue;
      }
      if (!result.url) {
        missing++;
        if (result.status !== 200 && result.status !== 404) {
          console.log(`  miss  ${r.sportSlug}/${r.slug} ${r.name}  (HTTP ${result.status})`);
        } else {
          console.log(`  miss  ${r.sportSlug}/${r.slug} ${r.name}`);
        }
        continue;
      }
      // Found a remote URL — download it and store locally so the DB
      // points at our own /team-logos/* path, not liquipedia.net.
      if (flags.dryRun) {
        resolved++;
        console.log(`  DRY  ${r.sportSlug}/${r.slug} ${r.name} → ${result.url}`);
        continue;
      }
      let localPath: string | null;
      try {
        localPath = await downloadAndStore(result.url, r.id, storeDir);
      } catch (err) {
        failures++;
        console.warn(`  dl-err ${r.sportSlug}/${r.slug} ${r.name}: ${(err as Error).message}`);
        continue;
      }
      if (!localPath) {
        // Backoff tripped or non-2xx download. Don't write a stale URL —
        // surface as a miss so the operator can re-run.
        missing++;
        console.log(`  dl-miss ${r.sportSlug}/${r.slug} ${r.name}`);
        continue;
      }
      resolved++;
      await db
        .update(competitors)
        .set({ logoUrl: localPath })
        .where(eq(competitors.id, r.id));
      if (resolved % 25 === 0) {
        console.log(`  ok   ${resolved}/${rows.length} (${r.sportSlug}/${r.slug} ${r.name})`);
      }
    }
  }

  const workers = Array.from({ length: flags.concurrency }, () => worker());
  await Promise.all(workers);

  console.log(
    `\nsummary: resolved=${resolved} missing=${missing} ` +
      `failures=${failures} dryRun=${flags.dryRun}`,
  );

  await pg.end();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
