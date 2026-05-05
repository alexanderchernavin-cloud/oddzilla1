// apply-logo-seed-direct.ts
//
// Apply curated logo overrides from seeds/competitor-logos.json directly
// against Postgres. Downloads each entry's remote logo URL into the
// /data/team-logos volume and stores the LOCAL `/team-logos/{id}.{ext}`
// path on `competitors.logo_url` — same self-hosting model as the
// resolver. brandColor and abbreviation pass through unchanged.
//
// Run from inside the api container so DATABASE_URL/LOGO_STORE_DIR resolve
// and the team-logos volume is mounted:
//
//   sudo -n docker exec -w /app/packages/db oddzilla-api-1 \
//     sh -c "pnpm db:apply-logo-seed"

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { and, eq, ilike } from "drizzle-orm";
import { createDb } from "./index.js";
import { competitors, sports } from "./schema/index.js";
import { downloadAndStore, ensureStoreDir, isLocalPath } from "./lib/logo-store.js";

interface SeedFile {
  entries: Array<{
    sportSlug: string;
    competitorSlug: string;
    logoUrl: string | null;
    brandColor?: string | null;
  }>;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const storeDir = process.env.LOGO_STORE_DIR ?? "/data/team-logos";
  try {
    await ensureStoreDir(storeDir);
  } catch (err) {
    console.error(`LOGO_STORE_DIR=${storeDir} not writable: ${(err as Error).message}`);
    process.exit(1);
  }

  const { db, sql: pg } = createDb(databaseUrl);

  const here = dirname(fileURLToPath(import.meta.url));
  const seedPath = resolve(here, "..", "seeds", "competitor-logos.json");
  const seed = JSON.parse(readFileSync(seedPath, "utf8")) as SeedFile;
  console.log(
    `loaded ${seed.entries.length} entries from ${seedPath}; storeDir=${storeDir}`,
  );

  const sportRows = await db
    .select({ id: sports.id, slug: sports.slug })
    .from(sports);
  const sportIdBySlug = new Map(sportRows.map((s) => [s.slug, s.id]));

  let updated = 0;
  let missing = 0;
  let downloadFailed = 0;
  for (const e of seed.entries) {
    const sportId = sportIdBySlug.get(e.sportSlug);
    if (!sportId) {
      console.warn(`  miss  ${e.sportSlug}/${e.competitorSlug} — sport_not_found`);
      missing++;
      continue;
    }
    const [match] = await db
      .select({ id: competitors.id, name: competitors.name })
      .from(competitors)
      .where(
        and(
          eq(competitors.sportId, sportId),
          ilike(competitors.slug, e.competitorSlug),
        ),
      )
      .limit(1);
    if (!match) {
      console.warn(`  miss  ${e.sportSlug}/${e.competitorSlug} — competitor_not_found`);
      missing++;
      continue;
    }

    // Resolve seed URL → local path.
    let storedLogo: string | null = null;
    if (e.logoUrl == null) {
      // Seed explicitly clears the logo (rare; mostly used to overwrite
      // a wrong resolver result with "no logo").
      storedLogo = null;
    } else if (isLocalPath(e.logoUrl)) {
      // Already a self-hosted path — pass through.
      storedLogo = e.logoUrl;
    } else {
      try {
        storedLogo = await downloadAndStore(e.logoUrl, match.id, storeDir);
      } catch (err) {
        console.warn(
          `  err   ${e.sportSlug}/${e.competitorSlug} download failed: ${(err as Error).message}`,
        );
        downloadFailed++;
        continue;
      }
      if (!storedLogo) {
        console.warn(
          `  err   ${e.sportSlug}/${e.competitorSlug} download returned no body (rate-limited?)`,
        );
        downloadFailed++;
        continue;
      }
    }

    const patch: { logoUrl: string | null; brandColor?: string | null } = {
      logoUrl: storedLogo,
    };
    if (e.brandColor !== undefined) patch.brandColor = e.brandColor;
    await db.update(competitors).set(patch).where(eq(competitors.id, match.id));
    console.log(`  ok    ${e.sportSlug}/${e.competitorSlug}  ${match.name} → ${storedLogo}`);
    updated++;
  }

  console.log(
    `\nsummary: updated=${updated} missing=${missing} downloadFailed=${downloadFailed}`,
  );
  await pg.end();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
