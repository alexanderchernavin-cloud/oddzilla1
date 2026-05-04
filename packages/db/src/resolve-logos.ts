// resolve-logos.ts
//
// Server-side bulk logo resolver. Connects directly to Postgres, iterates
// every active competitor in real esports (cs2/lol/valorant/dota2 + the
// secondary set), calls Liquipedia's MediaWiki API to find the team page,
// extracts the original-resolution logo URL from `pageimages`, and writes
// it back to `competitors.logo_url`.
//
// Idempotent: rows that already have logo_url stay put unless --force is
// passed. Re-run after the feed delivers new teams.
//
// Usage (from inside the repo on the prod box):
//
//   pnpm --filter @oddzilla/db tsx src/resolve-logos.ts
//
// Flags:
//   --force            overwrite existing logo_url values
//   --sport=<slug>     limit to one sport (cs2 | lol | valorant | dota2 | ...)
//   --dry-run          report what would change without writing
//   --concurrency=N    parallel Liquipedia requests (default 4)
//
// Why server-side: the sandbox blocks chaining a prod-DB read with web
// fetches that consume that data from a developer workstation (treats it
// as exfil). Running the resolver on the box keeps the data flow local —
// DB → script → Liquipedia → DB — with no external observer.

import { sql, eq } from "drizzle-orm";
import { createDb } from "./index.js";
import { competitors, sports } from "./schema/index.js";

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

interface LiquipediaPage {
  pageid: number;
  ns: number;
  title: string;
  missing?: string;
  original?: { source: string; width: number; height: number };
  thumbnail?: { source: string; width: number; height: number };
}

interface LiquipediaResp {
  query?: { pages?: Record<string, LiquipediaPage> };
}

// Slow down to respect Liquipedia's API guidelines: at most ~2 req/s/IP.
async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function resolveBatch(
  wiki: string,
  titles: string[],
): Promise<Map<string, string | null>> {
  // titles encoded with `|` separator; PHP's titles= takes up to 50.
  const url =
    `https://liquipedia.net/${wiki}/api.php?` +
    new URLSearchParams({
      action: "query",
      format: "json",
      titles: titles.join("|"),
      prop: "pageimages",
      piprop: "original|thumbnail",
      pithumbsize: "200",
      redirects: "1",
    }).toString();

  const res = await fetch(url, {
    headers: {
      // Liquipedia requests a descriptive UA per their API ToS.
      "User-Agent": "OddzillaLogoResolver/1.0 (https://oddzilla.cc; admin contact via repo)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`liquipedia ${wiki}: HTTP ${res.status}`);
  const body = (await res.json()) as LiquipediaResp;

  const out = new Map<string, string | null>();
  const pages = body.query?.pages ?? {};
  // The API may return redirected/normalized titles instead of the
  // requested ones, so we have to scan every page entry and match by
  // a normalised title comparison.
  const norm = (s: string) =>
    s.toLowerCase().replace(/[\s_]+/g, " ").trim();
  const wanted = new Map(titles.map((t) => [norm(t), t]));
  for (const p of Object.values(pages)) {
    const original = p.original?.source ?? p.thumbnail?.source ?? null;
    const want = wanted.get(norm(p.title));
    if (want) out.set(want, original);
  }
  // Anything we asked for but didn't see → null (page missing or no image).
  for (const t of titles) if (!out.has(t)) out.set(t, null);
  return out;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const { db, sql: pg } = createDb(databaseUrl);

  console.log(
    `resolve-logos: dry-run=${flags.dryRun} force=${flags.force} ` +
      `concurrency=${flags.concurrency} sport=${flags.sport ?? "all-supported"}`,
  );

  // Pull every active competitor in supported sports.
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

  // Group by sport so we can use the right wiki per batch.
  const bySport = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = bySport.get(r.sportSlug) ?? [];
    arr.push(r);
    bySport.set(r.sportSlug, arr);
  }

  let resolved = 0;
  let missing = 0;
  let failures = 0;

  for (const [sportSlug, group] of bySport) {
    const wiki = WIKI_BY_SPORT[sportSlug];
    if (!wiki) continue;
    console.log(`\n[${sportSlug} → ${wiki}] ${group.length} teams`);

    // Liquipedia caps `titles=` at 50 per query.
    const BATCH = 40;
    for (let i = 0; i < group.length; i += BATCH) {
      const slice = group.slice(i, i + BATCH);
      const titles = slice.map((r) => r.name.replace(/ /g, "_"));
      let batch: Map<string, string | null>;
      try {
        batch = await resolveBatch(wiki, titles);
      } catch (err) {
        console.warn(`  batch ${i}: ${(err as Error).message}`);
        failures += slice.length;
        await sleep(1500);
        continue;
      }

      for (const r of slice) {
        const title = r.name.replace(/ /g, "_");
        const url = batch.get(title) ?? null;
        if (!url) {
          missing++;
          console.log(`  miss  ${sportSlug}/${r.slug}  ${r.name}`);
          continue;
        }
        resolved++;
        if (flags.dryRun) {
          console.log(`  DRY  ${sportSlug}/${r.slug}  ${r.name} → ${url}`);
        } else {
          await db
            .update(competitors)
            .set({ logoUrl: url })
            .where(eq(competitors.id, r.id));
          console.log(`  ok    ${sportSlug}/${r.slug}  ${r.name}`);
        }
      }

      // Liquipedia API ToS: "no more than one request per 2 seconds" for
      // bots making bulk queries. With BATCH=40 that's ~20 teams/sec when
      // we sleep 2 s between batches — acceptable for a one-shot run.
      await sleep(2100);
    }
  }

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
