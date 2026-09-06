// Guards the migrations directory against the failure mode that git and a
// normal CI run both miss: two branches independently claiming the same
// migration number.
//
// WHY THIS EXISTS
//
// The number used to be a shared counter allocated from a local snapshot —
// you read packages/db/migrations/, took the highest number, added one. But
// you read YOUR branch's copy of that directory, which is main as it stood
// when you branched. Two branches off the same commit both see the same max
// and both write N+1. Nothing downstream notices:
//
//   - git can't. The branches add DIFFERENT FILES, so there is no textual
//     overlap and the merge is clean. A conflict is how git reports that two
//     changes disagree, and by that measure these don't.
//   - the migrate job can't. It applies every file to an empty database and
//     passes, because colliding migrations are usually unrelated. And with
//     both PRs open at once, neither run sees the other's file at all.
//
// So the collision exists only in the merged tree, which is the one state
// nobody built. It happened 11 times before this check was added (0045
// three ways).
//
// WHY IT MATTERS, beyond tidiness. migrate.ts sorts by filename, so a tie is
// broken by the DESCRIPTION TEXT: 0110_drop_live_chat runs before
// 0110_logo_source_wikipedia because 'd' < 'l'. That is luck, not intent.
// Worse, production applies each migration when its PR deploys — merge order
// — while a fresh dev or CI database applies them all in one pass in
// alphabetical order. When those two orders disagree you get two different
// schemas from the same repo, with no error anywhere.
//
// THE FIX this check enforces: the numeric era is frozen. New migrations use
// a UTC timestamp prefix (see NEW_FORM), which comes from a clock rather than
// from reading a directory, so two authors cannot collide. Every legacy
// `0NNN_` name sorts before every `YYYYMMDDTHHMMSS_` name ('0' < '2'), so the
// two eras concatenate cleanly and nothing needed renaming.
//
// Renaming matters here for a related reason: `_migrations` keys on the
// filename with no checksum, so renaming an APPLIED migration makes the
// runner treat it as new and run it a second time. That is why collisions
// are free to fix while a PR is open and expensive afterwards, and why the
// historical ones below are frozen rather than cleaned up.
//
// WHAT THIS DOES NOT CATCH. The prefix counts below detect a rename that
// CHANGES a file's prefix, and a deletion — but not a rename within the same
// prefix (0045_live_chat.sql -> 0045_live_chat_old.sql keeps the count at
// three and passes here), and not an edit to an already-applied file. Both
// need a content checksum recorded in `_migrations`, which is a schema change
// of its own and is deliberately not in this file's scope. Until that exists,
// "don't rename or edit an applied migration" is still a rule people have to
// know; this check enforces the part that can be enforced from the filenames
// alone.
//
// WHERE THIS RUNS. It is chained onto this package's `lint` script, so it
// runs inside the `pnpm lint` CI already does (the "TypeScript + Next.js"
// job) on every pull request AND every push to main — no workflow change
// needed. Turbo's `lint` task declares no `inputs`, so it hashes the whole
// package; adding or renaming a file under migrations/ changes that hash and
// forces a re-run rather than serving a cached pass.
//
// Standalone: pnpm --filter @oddzilla/db db:check-migrations
//
// Being on the PR is not quite the whole story. Two PRs open at once do not
// see each other's files, and the second to merge is not re-checked against
// the new base. "Require branches to be up to date before merging", and merge
// queues, both need GitHub Pro on a private repo and this one is on a free
// personal plan (the API answers 403, verified 2026-09-06), so that toggle
// does not exist here. The push-to-main run is what covers it: a collision
// that slips through turns main red within about a minute, which is inside
// the window where the fix is still free — renaming only becomes dangerous
// once a migration has been APPLIED, and applying happens on a manual
// `make deploy`, never automatically.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

// Legacy: a four-digit sequence number. Frozen — see LEGACY_FREEZE.
const LEGACY_FORM = /^(\d{4})_[a-z0-9_]+\.sql$/;
// Current: a UTC timestamp, `YYYYMMDDTHHMMSS`. Generate with
//   date -u +%Y%m%dT%H%M%S
const NEW_FORM = /^(\d{8}T\d{6})_[a-z0-9_]+\.sql$/;

// The highest legacy number ever issued. Anything above it must use a
// timestamp. Do NOT raise this to squeeze in one more numbered migration —
// raising it re-opens the exact race this file exists to close.
const LEGACY_FREEZE = 110;

// Historical collisions, frozen. Every one of these is already applied on
// production and on every developer database, so renaming them is not an
// option (it would re-run them). The count is the number of files that
// legitimately share the prefix; anything else is a new mistake.
const GRANDFATHERED: Readonly<Record<string, number>> = {
  "0037": 2,
  "0045": 3,
  "0051": 2,
  "0056": 2,
  "0073": 2,
  "0075": 2,
  "0076": 2,
  "0077": 2,
  "0106": 2,
  "0109": 2,
  "0110": 2,
};

const errors: string[] = [];

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  console.error("check-migrations: no .sql files found — wrong directory?");
  process.exit(1);
}

// ── 1. Every file uses one of the two supported forms ──────────────────────
const legacy: string[] = [];
const stamped: string[] = [];
const prefixOf = new Map<string, string>();

for (const file of files) {
  const legacyMatch = LEGACY_FORM.exec(file);
  const stampedMatch = NEW_FORM.exec(file);

  if (legacyMatch?.[1]) {
    legacy.push(file);
    prefixOf.set(file, legacyMatch[1]);
    // ── 2. The numeric era is frozen ──────────────────────────────────────
    if (Number(legacyMatch[1]) > LEGACY_FREEZE) {
      errors.push(
        `${file}: numbered migrations are frozen at ${String(LEGACY_FREEZE).padStart(4, "0")}. ` +
          `Rename it to a UTC timestamp prefix — \`date -u +%Y%m%dT%H%M%S\` — ` +
          `e.g. 20260906T004012_${file.slice(5)}. A sequence number read from ` +
          `your branch's copy of this directory is not unique across branches.`,
      );
    }
    continue;
  }

  if (stampedMatch?.[1]) {
    stamped.push(file);
    prefixOf.set(file, stampedMatch[1]);
    if (!isRealTimestamp(stampedMatch[1])) {
      errors.push(
        `${file}: prefix "${stampedMatch[1]}" is not a real UTC timestamp. ` +
          `Generate it with \`date -u +%Y%m%dT%H%M%S\`.`,
      );
    }
    continue;
  }

  errors.push(
    `${file}: unrecognised migration filename. Use ` +
      `YYYYMMDDTHHMMSS_lower_snake_case.sql (\`date -u +%Y%m%dT%H%M%S\`).`,
  );
}

// ── 3. No two migrations share a prefix ────────────────────────────────────
// Counted rather than merely detected, so that adding a fourth 0045_ file is
// caught even though 0045 is already a known collision. The count also moves
// when a frozen file is deleted or renamed ACROSS prefixes; a rename within
// one prefix is invisible here (see WHAT THIS DOES NOT CATCH above).
const counts = new Map<string, number>();
for (const file of files) {
  const prefix = prefixOf.get(file);
  if (prefix === undefined) continue; // already reported as malformed
  counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
}

for (const [prefix, actual] of [...counts].sort()) {
  const expected = GRANDFATHERED[prefix] ?? 1;
  if (actual === expected) continue;

  const sharing = files.filter((f) => prefixOf.get(f) === prefix);
  if (actual > expected) {
    errors.push(
      `prefix "${prefix}" is claimed by ${actual} migrations: ${sharing.join(", ")}. ` +
        `Two branches picked the same number. Rename the one that has NOT been ` +
        `applied anywhere yet — renaming is free while the PR is open and ` +
        `re-runs the migration once it has been applied, because _migrations ` +
        `keys on the filename.`,
    );
  } else {
    errors.push(
      `prefix "${prefix}" has ${actual} migrations but ${expected} are recorded as ` +
        `applied: ${sharing.join(", ") || "(none left)"}. An applied migration was ` +
        `deleted, or renamed onto a different prefix. Both are unsafe — the runner ` +
        `keys _migrations on the filename, so a rename re-runs it and a deletion ` +
        `leaves fresh databases missing a change production already has. Restore ` +
        `the original name.`,
    );
  }
}

// ── 4. The two eras must not interleave ────────────────────────────────────
// migrate.ts applies files in plain lexicographic order, and the whole reason
// the timestamp switch needed no renames is that every legacy name sorts
// before every timestamped one. Assert it rather than trusting that '0' < '2'
// stays true of whatever gets added later.
const lastLegacy = legacy.at(-1);
const firstStamped = stamped.at(0);
if (lastLegacy && firstStamped && !(lastLegacy < firstStamped)) {
  errors.push(
    `ordering broken: "${lastLegacy}" does not sort before "${firstStamped}". ` +
      `migrate.ts applies files in lexicographic order, so every legacy ` +
      `numbered migration must sort ahead of every timestamped one.`,
  );
}

if (errors.length > 0) {
  console.error(`check-migrations: ${errors.length} problem(s)\n`);
  for (const e of errors) console.error(`  - ${e}\n`);
  process.exit(1);
}

console.log(
  `check-migrations: ok — ${files.length} migrations ` +
    `(${legacy.length} legacy numbered, ${stamped.length} timestamped), no prefix collisions`,
);

// `new Date(...)` accepts overflowing components (month 13 rolls into the
// next year), so round-trip the parts instead of trusting the parse.
function isRealTimestamp(stamp: string): boolean {
  const year = Number(stamp.slice(0, 4));
  const month = Number(stamp.slice(4, 6));
  const day = Number(stamp.slice(6, 8));
  const hour = Number(stamp.slice(9, 11));
  const minute = Number(stamp.slice(11, 13));
  const second = Number(stamp.slice(13, 15));
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day &&
    d.getUTCHours() === hour &&
    d.getUTCMinutes() === minute &&
    d.getUTCSeconds() === second
  );
}
