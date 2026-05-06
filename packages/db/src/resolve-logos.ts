// resolve-logos.ts
//
// Copy each cached `competitor_profiles.icon_path` (cdn.oddin.gg URL,
// populated by feed-ingester from Oddin's competitor profile REST
// endpoint) directly onto `competitors.logo_url`. The browser then
// hot-links the CDN — Oddin is our authorised data partner so it's
// fine to lean on their CDN, no rate-limit / hot-link headache like
// the Wikipedia / Liquipedia detour earlier had.
//
// Pure SQL — no HTTP, no file I/O. Idempotent: rows whose logo_url
// already matches the cached icon_path are no-ops (the UPDATE only
// touches rows where it changes anything).
//
// Usage:
//   sudo -n docker exec -w /app/packages/db oddzilla-api-1 \
//     sh -c "pnpm db:resolve-logos"
//
// Flags:
//   --force            also overwrite rows where logo_url is already set
//                      to a different non-Oddin URL or local /team-logos/
//                      path (legacy state — no new code paths produce
//                      anything but cdn.oddin.gg URLs now).
//   --dry-run          report counts without UPDATE.
//   --sport=<slug>     limit to one sport.

import { sql } from "drizzle-orm";
import { createDb } from "./index.js";

interface CliFlags {
  force: boolean;
  dryRun: boolean;
  sport: string | null;
}

function parseFlags(argv: string[]): CliFlags {
  const out: CliFlags = { force: false, dryRun: false, sport: null };
  for (const a of argv) {
    if (a === "--force") out.force = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--sport=")) out.sport = a.slice("--sport=".length);
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

  const { sql: pg } = createDb(databaseUrl);

  console.log(
    `resolve-logos: dry-run=${flags.dryRun} force=${flags.force} ` +
      `sport=${flags.sport ?? "all"}`,
  );

  // Built incrementally; postgres-js takes parameter binds via tagged
  // template, but UPDATE/COUNT both share the same WHERE clause so we
  // construct it once with raw SQL fragments.
  const sportFilter = flags.sport
    ? pg`AND s.slug = ${flags.sport}`
    : pg``;
  const overwriteGuard = flags.force
    ? pg``
    : pg`AND (c.logo_url IS NULL OR c.logo_url <> p.icon_path)`;

  // Count first — gives the operator a sanity check before the write,
  // and matches the dry-run output without forking the WHERE clause.
  const countRows = await pg<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
      FROM competitors c
      JOIN sports s ON s.id = c.sport_id
      JOIN competitor_profiles p ON p.urn = c.provider_urn
     WHERE c.active = true
       AND p.icon_path IS NOT NULL
       AND p.icon_path <> ''
       ${sportFilter}
       ${overwriteGuard}
  `;
  const candidates = Number(countRows[0]?.count ?? "0");
  console.log(`candidates: ${candidates}`);

  if (flags.dryRun) {
    console.log("dry-run: no rows updated");
    await pg.end();
    return;
  }

  // Single UPDATE … FROM does the whole job in one round trip. Faster
  // than the per-row download loop the previous implementation used —
  // there's no I/O at all now, just postgres.
  const updated = await pg`
    UPDATE competitors c
       SET logo_url = p.icon_path
      FROM competitor_profiles p,
           sports s
     WHERE p.urn = c.provider_urn
       AND s.id = c.sport_id
       AND c.active = true
       AND p.icon_path IS NOT NULL
       AND p.icon_path <> ''
       ${sportFilter}
       ${overwriteGuard}
  `;

  console.log(`updated: ${updated.count} row(s)`);
  await pg.end();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
