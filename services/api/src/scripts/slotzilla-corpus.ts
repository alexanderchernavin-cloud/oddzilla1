// slotzilla-corpus.ts — pull finished basketball games' play-by-play
// from Sportradar's open statistics host into `sr_live_events` so the
// SlotZilla calibrator has rounds to measure. The same loop the
// backoffice's POST /admin/slotzilla/corpus/fetch runs, for an operator
// who would rather drive it from a shell (a long backfill, a cron).
//
// Usage (inside the api container, where DATABASE_URL is set):
//   pnpm slotzilla:corpus -- --from=2026-09-01 --to=2026-09-09 [--sport=2] [--max=200]
//
// Flags:
//   --from=YYYY-MM-DD   first UTC day (required)
//   --to=YYYY-MM-DD     last UTC day, inclusive (defaults to --from)
//   --sport=<srSportId> Sportradar sport id (default 2, basketball)
//   --max=<n>           at most this many new matches (default 200)
//   --base=<url>        override the gismo base URL
//
// Exits non-zero on a usage error or an unhandled fetch failure; a
// single match that fails is logged and skipped like the route does.

import { createDb } from "@oddzilla/db";
import pino from "pino";
import { createCorpusClient, fetchCorpus } from "../lib/slotzilla/corpus.js";

interface Flags {
  from: string | null;
  to: string | null;
  sport: number;
  max: number;
  base: string | undefined;
}

function parseFlags(argv: string[]): Flags {
  const out: Flags = { from: null, to: null, sport: 2, max: 200, base: undefined };
  for (const a of argv) {
    const [k, v = ""] = a.split("=", 2) as [string, string?];
    switch (k) {
      case "--from":
        out.from = v;
        break;
      case "--to":
        out.to = v;
        break;
      case "--sport":
        out.sport = Number(v);
        break;
      case "--max":
        out.max = Number(v);
        break;
      case "--base":
        out.base = v;
        break;
      default:
        throw new Error(`unknown flag ${a}`);
    }
  }
  if (!out.from || !/^\d{4}-\d{2}-\d{2}$/u.test(out.from)) {
    throw new Error("--from=YYYY-MM-DD is required");
  }
  if (!out.to) out.to = out.from;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(out.to)) throw new Error("--to must be YYYY-MM-DD");
  if (!Number.isInteger(out.sport) || out.sport <= 0) throw new Error("--sport must be a positive integer");
  if (!Number.isInteger(out.max) || out.max <= 0) throw new Error("--max must be a positive integer");
  return out;
}

async function main(): Promise<void> {
  const log = pino({ level: process.env.LOG_LEVEL ?? "info" }).child({
    service: "api",
    component: "slotzilla-corpus",
  });
  const flags = parseFlags(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const { db, sql } = createDb(databaseUrl);
  try {
    const client = createCorpusClient(flags.base ? { baseUrl: flags.base } : {});
    const result = await fetchCorpus(
      db,
      client,
      { from: flags.from!, to: flags.to!, srSportId: flags.sport, maxMatches: flags.max },
      log,
    );
    log.info({ event: "corpus_fetch_done", ...result }, "slotzilla corpus fetched");
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
