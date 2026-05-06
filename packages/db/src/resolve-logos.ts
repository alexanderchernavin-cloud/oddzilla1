// resolve-logos.ts
//
// Bulk-resolve team logos from Oddin's competitor profile cache.
// Oddin returns `icon_path` on /v1/sports/{lang}/competitors/{urn}/profile
// pointing at cdn.oddin.gg/assets/teams/icons/<file>.png; feed-ingester
// already calls that endpoint and persists the URL into
// `competitor_profiles.icon_path` for every team that appears in the
// match feed (see services/feed-ingester/internal/automap/resolver.go
// `CacheCompetitorProfile`). Coverage on prod: 1861/2135 cached
// profiles have an icon_path set (~87%); the rest fall back to the
// `TeamMark` initials block on the storefront.
//
// This script joins competitors to that cache, downloads each icon into
// the /data/team-logos volume, and writes the local path back to
// `competitors.logo_url`. There is no fallback source — Oddin is the
// canonical and only resolver because any team Oddin doesn't already
// give us a logo for isn't worth scraping a third-party for: the team
// either isn't in the feed at all, or its profile hasn't been
// REST-fetched yet (in which case re-running the resolver after the
// next match ingest fills it in).
//
// Idempotent: skips rows that already have a /team-logos/ path unless
// --force. Run inside the api container (docker network resolves
// `postgres`, the team-logos volume is mounted, DATABASE_URL set):
//
//   sudo -n docker exec -w /app/packages/db oddzilla-api-1 \
//     sh -c "pnpm db:resolve-logos"
//
// Flags:
//   --force            overwrite existing logo_url values
//   --dry-run          report what would change without writing
//   --concurrency=N    parallel downloads (default 4, max 16)
//   --sport=<slug>     limit to one sport

import { sql, eq, and } from "drizzle-orm";
import { createDb } from "./index.js";
import { competitors, sports, competitorProfiles } from "./schema/index.js";
import { downloadAndStore, ensureStoreDir } from "./lib/logo-store.js";

interface CliFlags {
  force: boolean;
  dryRun: boolean;
  concurrency: number;
  sport: string | null;
}

function parseFlags(argv: string[]): CliFlags {
  const out: CliFlags = { force: false, dryRun: false, concurrency: 4, sport: null };
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
      console.error(`LOGO_STORE_DIR=${storeDir} not writable: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  const { db, sql: pg } = createDb(databaseUrl);

  console.log(
    `resolve-oddin-icons: dry-run=${flags.dryRun} force=${flags.force} ` +
      `concurrency=${flags.concurrency} sport=${flags.sport ?? "all"} ` +
      `storeDir=${storeDir}`,
  );

  // Pull every active competitor that has both a provider_urn and a
  // cached icon_path. Without --force we skip rows already pointing at
  // a /team-logos/ path (typical re-run case).
  const conditions = [
    eq(competitors.active, true),
    sql`${competitors.providerUrn} IS NOT NULL`,
    sql`${competitorProfiles.iconPath} IS NOT NULL`,
    sql`${competitorProfiles.iconPath} <> ''`,
  ];
  if (!flags.force) {
    conditions.push(
      sql`(${competitors.logoUrl} IS NULL OR ${competitors.logoUrl} NOT LIKE '/team-logos/%')`,
    );
  }
  if (flags.sport) {
    conditions.push(eq(sports.slug, flags.sport));
  }

  const rows = await db
    .select({
      id: competitors.id,
      name: competitors.name,
      sportSlug: sports.slug,
      iconPath: competitorProfiles.iconPath,
    })
    .from(competitors)
    .innerJoin(sports, eq(sports.id, competitors.sportId))
    .innerJoin(
      competitorProfiles,
      eq(competitorProfiles.urn, competitors.providerUrn),
    )
    .where(and(...conditions));

  console.log(`found ${rows.length} competitor rows with cached icon_path`);

  let resolved = 0;
  let failed = 0;

  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) return;
      const r = rows[i];
      if (!r) return;
      // The SQL where clause already excludes null icon_paths but the
      // typesystem sees the column as nullable — narrow it before use.
      if (!r.iconPath) {
        failed++;
        continue;
      }
      const iconUrl = r.iconPath;

      if (flags.dryRun) {
        resolved++;
        console.log(`  DRY  ${r.sportSlug}/${r.id} ${r.name} ← ${iconUrl}`);
        continue;
      }

      let local: string | null;
      try {
        local = await downloadAndStore(iconUrl, r.id, storeDir);
      } catch (err) {
        console.warn(`  err  ${r.sportSlug}/${r.id} ${r.name}: ${(err as Error).message}`);
        failed++;
        continue;
      }
      if (!local) {
        console.warn(`  fail ${r.sportSlug}/${r.id} ${r.name} (download returned null)`);
        failed++;
        continue;
      }

      await db
        .update(competitors)
        .set({ logoUrl: local })
        .where(eq(competitors.id, r.id));
      resolved++;
      if (resolved % 50 === 0) {
        console.log(`  ok   ${resolved}/${rows.length} (${r.name})`);
      }
    }
  }

  const workers = Array.from({ length: flags.concurrency }, () => worker());
  await Promise.all(workers);

  console.log(`\nsummary: resolved=${resolved} failed=${failed} dryRun=${flags.dryRun}`);
  await pg.end();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
