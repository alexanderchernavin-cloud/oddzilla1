// localize-logos.ts
//
// One-shot fix-up: scan `competitors` for rows whose logo_url points at
// a third-party host (liquipedia.net etc.), download the asset to the
// /data/team-logos volume, and rewrite the row to the local
// `/team-logos/{id}.{ext}` path.
//
// Idempotent: rows that are already self-hosted (`/team-logos/...`) or
// have NULL logo_url are skipped. Failed downloads keep the original
// remote URL so the storefront keeps rendering whatever it had — re-run
// after the rate limit lifts to fix them.
//
// Run from inside the api container:
//
//   sudo -n docker exec -w /app/packages/db oddzilla-api-1 \
//     sh -c "pnpm db:localize-logos"

import { eq, isNotNull, and, not, like } from "drizzle-orm";
import { createDb } from "./index.js";
import { competitors } from "./schema/index.js";
import { downloadAndStore, ensureStoreDir, isLocalPath } from "./lib/logo-store.js";

interface CliFlags {
  dryRun: boolean;
  concurrency: number;
}

function parseFlags(argv: string[]): CliFlags {
  const out: CliFlags = { dryRun: false, concurrency: 3 };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--concurrency=")) {
      const n = Number.parseInt(a.slice("--concurrency=".length), 10);
      if (Number.isFinite(n) && n > 0) out.concurrency = Math.min(8, n);
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

  // Pull every row whose logo_url is set and not already self-hosted.
  // The NOT LIKE filter catches both literal `/team-logos/...` and any
  // future relative-path schemes we might adopt — anything starting with
  // `/` is treated as already-local.
  const rows = await db
    .select({
      id: competitors.id,
      name: competitors.name,
      logoUrl: competitors.logoUrl,
    })
    .from(competitors)
    .where(
      and(
        isNotNull(competitors.logoUrl),
        not(like(competitors.logoUrl, "/team-logos/%")),
      ),
    );
  console.log(
    `localize-logos: dry-run=${flags.dryRun} concurrency=${flags.concurrency} ` +
      `storeDir=${storeDir} candidates=${rows.length}`,
  );

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) return;
      const r = rows[i];
      if (!r || !r.logoUrl) return;
      if (isLocalPath(r.logoUrl)) {
        skipped++;
        continue;
      }
      if (flags.dryRun) {
        console.log(`  DRY  ${r.id} ${r.name} ${r.logoUrl} → /team-logos/${r.id}.{ext}`);
        updated++;
        continue;
      }
      let local: string | null;
      try {
        local = await downloadAndStore(r.logoUrl, r.id, storeDir);
      } catch (err) {
        console.warn(`  err  ${r.id} ${r.name}: ${(err as Error).message}`);
        failed++;
        continue;
      }
      if (!local) {
        console.warn(`  fail ${r.id} ${r.name} (rate-limited or non-2xx)`);
        failed++;
        continue;
      }
      await db
        .update(competitors)
        .set({ logoUrl: local })
        .where(eq(competitors.id, r.id));
      updated++;
      if (updated % 25 === 0) {
        console.log(`  ok   ${updated}/${rows.length} (${r.name})`);
      }
    }
  }

  const workers = Array.from({ length: flags.concurrency }, () => worker());
  await Promise.all(workers);

  console.log(
    `\nsummary: updated=${updated} skipped=${skipped} failed=${failed} dryRun=${flags.dryRun}`,
  );
  await pg.end();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
