// apply-logo-seed-direct.ts
//
// Apply curated logo overrides from seeds/competitor-logos.json directly
// against Postgres — no API hop, no admin auth. Same matching rules as
// the /admin/competitors/bulk-logos endpoint: case-insensitive (sport_slug,
// competitor_slug). Used in cases where the resolver can't reach
// Liquipedia or you want to pin a specific brand colour.
//
// Run from inside the api container so DATABASE_URL resolves the
// `postgres` service name on the docker network.
//
//   sudo -n docker exec -w /app/packages/db oddzilla-api-1 \
//     sh -c "pnpm tsx src/apply-logo-seed-direct.ts"

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { and, eq, ilike } from "drizzle-orm";
import { createDb } from "./index.js";
import { competitors, sports } from "./schema/index.js";

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
  const { db, sql: pg } = createDb(databaseUrl);

  const here = dirname(fileURLToPath(import.meta.url));
  const seedPath = resolve(here, "..", "seeds", "competitor-logos.json");
  const seed = JSON.parse(readFileSync(seedPath, "utf8")) as SeedFile;
  console.log(`loaded ${seed.entries.length} entries from ${seedPath}`);

  // Cache sport-slug → id for fewer round trips.
  const sportRows = await db
    .select({ id: sports.id, slug: sports.slug })
    .from(sports);
  const sportIdBySlug = new Map(sportRows.map((s) => [s.slug, s.id]));

  let updated = 0;
  let missing = 0;
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
    const patch: { logoUrl: string | null; brandColor?: string | null } = {
      logoUrl: e.logoUrl,
    };
    if (e.brandColor !== undefined) patch.brandColor = e.brandColor;
    await db.update(competitors).set(patch).where(eq(competitors.id, match.id));
    console.log(`  ok    ${e.sportSlug}/${e.competitorSlug}  ${match.name}`);
    updated++;
  }

  console.log(`\nsummary: updated=${updated} missing=${missing}`);
  await pg.end();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
