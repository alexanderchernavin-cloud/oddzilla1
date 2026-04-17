// Applies hand-written SQL migrations from ./migrations in order.
// We own the SQL file list ourselves rather than using drizzle-kit migrate
// because our 0001 partitions migration uses pg_partman features drizzle-kit
// cannot represent, and we want Go services to replay the exact same SQL.

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

async function main() {
  const sql = postgres(databaseUrl!, { max: 1, prepare: false });

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const name of files) {
    const [{ count }] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM _migrations WHERE name = ${name}
    `;
    if (Number(count) > 0) {
      console.log(`skip   ${name} (already applied)`);
      continue;
    }

    const content = await readFile(join(migrationsDir, name), "utf8");
    console.log(`apply  ${name}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`INSERT INTO _migrations (name) VALUES (${name})`;
    });
  }

  console.log("migrations complete");
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
