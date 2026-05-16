// Admin /deploy endpoints — read-only view of the deploy pipeline:
//
//   GET /admin/deploy/status
//     One payload with everything the /admin/deploy page needs:
//       • current  — what's running (sha, msg, author, deployedAt)
//       • pending  — commits ahead on origin/main with their file diffs
//                    + the service set that `make deploy` would rebuild
//                    + whether migrations are pending
//       • log      — recent .deploy/log entries (deploy / rollback /
//                    smoke_fail) with parsed timestamp + services
//       • rollback — for each service, the SHA that `make rollback`
//                    would revert to, plus whether the corresponding
//                    docker image is still tagged on the host
//       • backups  — pre-deploy pg snapshots under .deploy/backups/
//
// Triggering deploys / rollbacks from the API is intentionally NOT
// here. That would require giving the api container shell access to
// docker + sudo, which inverts the security model. The page is
// observability-only; operators still run `make deploy` from SSH.
//
// Graceful idle:
//
//   When DEPLOY_STATE_DIR points at a directory that doesn't exist
//   (typical for local dev), every section returns its empty shape
//   and an `available: false` flag at the top of the response. The
//   admin page renders a "not available in this environment" notice
//   instead of error-borking.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { runGitNoShell } from "./deploy-git.js";

// Where to read state from. In prod the api compose entry bind-mounts
// /home/team/oddzilla/.deploy here. In dev the path won't exist and
// the route falls back to the empty/unavailable shape.
const STATE_DIR = process.env.DEPLOY_STATE_DIR ?? "/srv/deploy-state";

// How many past deploy events to surface. The log file is append-only
// and grows slowly — but the UI is more readable with a finite window.
// 50 covers ~a quarter of normal cadence; older entries are still on
// disk for the curious operator.
const LOG_TAIL = 50;
// In-memory cache so a refresh-spamming admin doesn't fork git on
// every click. 15s is short enough that "I just deployed, what's
// the state" feels live and long enough to absorb tab-switch reloads.
const CACHE_TTL_MS = 15_000;

interface CommitMeta {
  sha: string;
  short: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string; // ISO
}

interface PendingCommit extends CommitMeta {
  filesChanged: number;
}

interface DeployLogEntry {
  ts: string;            // ISO from the log line's leading column
  kind: string;          // deploy | rollback | smoke_fail | …
  sha: string;
  short: string;
  services: string[];
  // Anything after services=… that the script tacked on (e.g.
  // `migrations=1`, `from=<prev-sha>`). Forwarded as a raw string so
  // the UI can render the operator-visible extra context without
  // baking knowledge of every field here.
  extras: Record<string, string>;
}

interface RollbackTarget {
  service: string;
  // Most-recent SHA stored in .deploy/images/<svc>; this is what's
  // running right now (the deploy script writes it after each successful
  // build).
  currentSha: string | null;
  currentShort: string | null;
  currentImagePresent: boolean;
  // Second entry — what `make rollback` would retag to :latest.
  previousSha: string | null;
  previousShort: string | null;
  previousImagePresent: boolean;
  // Everything further back, in case the operator needs to roll back
  // more than one step. Always includes current + previous if present.
  history: Array<{ sha: string; short: string; imagePresent: boolean }>;
}

interface BackupEntry {
  file: string;          // basename only
  sha: string;           // matches the migrating commit
  short: string;
  bytes: number;
  modifiedAt: string;    // ISO
}

interface DeployStatusResponse {
  available: boolean;
  // Why we couldn't read the state (e.g. missing dir, missing git).
  // Null when available is true.
  reason: string | null;
  current: {
    sha: string | null;
    short: string | null;
    commit: CommitMeta | null;
    deployedAt: string | null;
  };
  pending: {
    targetSha: string | null;
    targetShort: string | null;
    commits: PendingCommit[];
    services: string[];
    migrations: string[];
  };
  log: DeployLogEntry[];
  rollback: RollbackTarget[];
  backups: BackupEntry[];
}

// Cache the whole response payload — git log / image inspect / etc.
// are all read-only and tolerate a few seconds of staleness in the UI.
let cached: { at: number; payload: DeployStatusResponse } | null = null;

export default async function adminDeployRoutes(app: FastifyInstance) {
  app.get("/admin/deploy/status", async (request) => {
    request.requireRole("admin");
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.payload;
    }
    const payload = await loadStatus();
    cached = { at: Date.now(), payload };
    return payload;
  });
}

async function loadStatus(): Promise<DeployStatusResponse> {
  const empty: DeployStatusResponse = {
    available: false,
    reason: null,
    current: { sha: null, short: null, commit: null, deployedAt: null },
    pending: {
      targetSha: null,
      targetShort: null,
      commits: [],
      services: [],
      migrations: [],
    },
    log: [],
    rollback: [],
    backups: [],
  };

  // Fast path: probe the state dir up front so the UI gets a clear
  // "not configured" rather than a wall of git errors when the bind
  // mount is missing (common in local dev).
  try {
    await fs.stat(STATE_DIR);
  } catch {
    return { ...empty, reason: `state dir missing: ${STATE_DIR}` };
  }

  // Probe git availability separately — state files still readable
  // even when no .git/ is mounted; commit metadata will just be empty.
  let gitAvailable = true;
  try {
    await runGitNoShell(["rev-parse", "HEAD"]);
  } catch {
    gitAvailable = false;
  }

  // Read all state in parallel; each piece's failure is isolated so a
  // single missing file doesn't take down the whole page.
  const [
    lastSha,
    logEntries,
    backups,
    imageManifests,
    targetSha,
  ] = await Promise.all([
    readLastSha(),
    readLog(LOG_TAIL),
    readBackups(),
    readImageManifests(),
    gitAvailable ? readOriginMainSha() : Promise.resolve(null),
  ]);

  // Hydrate commit metadata via git for any SHA we mention in the UI.
  // Pre-collect unique SHAs so we make exactly one `git log -n N` call
  // worth of work per response (cache via a Map).
  const wantSHAs = new Set<string>();
  if (lastSha) wantSHAs.add(lastSha);
  if (targetSha) wantSHAs.add(targetSha);
  for (const e of logEntries) wantSHAs.add(e.sha);
  for (const m of imageManifests.values()) {
    for (const sha of m) wantSHAs.add(sha);
  }
  for (const b of backups) wantSHAs.add(b.sha);
  const meta = gitAvailable
    ? await hydrateCommitMeta(Array.from(wantSHAs))
    : new Map<string, CommitMeta>();

  // Pending commits + their file diffs only make sense when both
  // sides of the range exist and git is reachable.
  let pendingCommits: PendingCommit[] = [];
  let pendingServices: string[] = [];
  let pendingMigrations: string[] = [];
  if (gitAvailable && lastSha && targetSha && lastSha !== targetSha) {
    pendingCommits = await readPendingCommits(lastSha, targetSha);
    const allFiles = await readChangedFiles(lastSha, targetSha);
    pendingServices = mapFilesToServices(allFiles);
    pendingMigrations = allFiles.filter((f) =>
      /^packages\/db\/migrations\/[0-9].*\.sql$/.test(f),
    );
  }

  // Current deploy timestamp is the timestamp of the most recent
  // `deploy` event in the log whose SHA matches last-sha. If no log
  // entry exists yet (first deploy hasn't run through the new
  // pipeline) we leave it null.
  const currentDeployedAt = lastSha
    ? logEntries.find((e) => e.kind === "deploy" && e.sha === lastSha)?.ts ??
      null
    : null;

  // Per-service rollback targets — only services that have a manifest
  // file are listed.
  const imagePresence = await checkImages(imageManifests);
  const rollback = buildRollback(imageManifests, imagePresence);

  return {
    available: true,
    reason: gitAvailable ? null : "git history unavailable",
    current: {
      sha: lastSha,
      short: lastSha ? shortSha(lastSha) : null,
      commit: lastSha ? meta.get(lastSha) ?? null : null,
      deployedAt: currentDeployedAt,
    },
    pending: {
      targetSha,
      targetShort: targetSha ? shortSha(targetSha) : null,
      commits: pendingCommits,
      services: pendingServices,
      migrations: pendingMigrations,
    },
    log: logEntries.map((e) => ({ ...e, short: shortSha(e.sha) })),
    rollback,
    backups: backups.map((b) => ({
      ...b,
      short: shortSha(b.sha),
    })),
  };
}

// ── State file readers ──────────────────────────────────────────────

async function readLastSha(): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(STATE_DIR, "last-sha"), "utf8");
    const s = raw.trim();
    return /^[0-9a-f]{40}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

async function readLog(limit: number): Promise<DeployLogEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(STATE_DIR, "log"), "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  // Newest first.
  const recent = lines.slice(-limit).reverse();
  return recent.map(parseLogLine).filter((e): e is DeployLogEntry => e != null);
}

function parseLogLine(line: string): DeployLogEntry | null {
  // Format: `<ts> <kind> <sha> services=<csv> [key=value ...]`
  const m = /^(\S+)\s+(\S+)\s+([0-9a-f]{40})\s+(.*)$/.exec(line);
  if (!m) return null;
  const [, ts, kind, sha, rest] = m;
  if (!ts || !kind || !sha || rest == null) return null;
  const fields = rest.split(/\s+/);
  let services: string[] = [];
  const extras: Record<string, string> = {};
  for (const f of fields) {
    const eq = f.indexOf("=");
    if (eq < 0) continue;
    const key = f.slice(0, eq);
    const val = f.slice(eq + 1);
    if (key === "services") {
      services = val === "-" ? [] : val.split(",").filter((s) => s.length > 0);
    } else {
      extras[key] = val;
    }
  }
  return { ts, kind, sha, short: shortSha(sha), services, extras };
}

async function readBackups(): Promise<BackupEntry[]> {
  const dir = path.join(STATE_DIR, "backups");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: BackupEntry[] = [];
  for (const name of entries) {
    const m = /^([0-9a-f]{40})\.sql\.gz$/.exec(name);
    if (!m) continue;
    try {
      const stat = await fs.stat(path.join(dir, name));
      const sha = m[1];
      if (!sha) continue;
      out.push({
        file: name,
        sha,
        short: shortSha(sha),
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch {
      // Skip unreadable entries; don't bork the whole list.
    }
  }
  // Newest first by mtime.
  out.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  return out;
}

// Per-service rollback manifest. Returns Map<service, [sha,...]>
// (most-recent-first), one entry per file under .deploy/images/.
async function readImageManifests(): Promise<Map<string, string[]>> {
  const dir = path.join(STATE_DIR, "images");
  const out = new Map<string, string[]>();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const svc of entries) {
    try {
      const raw = await fs.readFile(path.join(dir, svc), "utf8");
      const shas = raw
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => /^[0-9a-f]{40}$/.test(s));
      if (shas.length > 0) out.set(svc, shas);
    } catch {
      // Skip — the deploy.sh writer is atomic so the only way we end
      // up here is a fresh service with no recorded image yet.
    }
  }
  return out;
}

// ── Git readers ─────────────────────────────────────────────────────

async function readOriginMainSha(): Promise<string | null> {
  try {
    const out = await runGitNoShell(["rev-parse", "refs/remotes/origin/main"]);
    const s = out.trim();
    return /^[0-9a-f]{40}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

async function readPendingCommits(
  from: string,
  to: string,
): Promise<PendingCommit[]> {
  // %x1f = unit separator; safe field delimiter (subjects don't
  // contain it). %x1e = record separator between commits.
  const fmt = ["%H", "%h", "%s", "%an", "%ae", "%aI"].join("%x1f");
  let out: string;
  try {
    out = await runGitNoShell([
      "log",
      `--pretty=tformat:${fmt}%x1e`,
      `${from}..${to}`,
    ]);
  } catch {
    return [];
  }
  const commits: PendingCommit[] = [];
  const records = out.split("\x1e").filter((r) => r.trim().length > 0);
  for (const rec of records) {
    const parts = rec.replace(/^\n/, "").split("\x1f");
    if (parts.length < 6) continue;
    const [sha, _short, subject, an, ae, ai] = parts;
    if (!sha || !subject || !ai) continue;
    let filesChanged = 0;
    try {
      const diff = await runGitNoShell([
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        sha,
      ]);
      filesChanged = diff.split("\n").filter((l) => l.trim().length > 0).length;
    } catch {
      filesChanged = 0;
    }
    commits.push({
      sha,
      short: shortSha(sha),
      subject,
      authorName: an ?? "",
      authorEmail: ae ?? "",
      authoredAt: ai,
      filesChanged,
    });
  }
  return commits;
}

async function readChangedFiles(from: string, to: string): Promise<string[]> {
  try {
    const out = await runGitNoShell([
      "diff",
      "--name-only",
      `${from}..${to}`,
    ]);
    return out.split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

async function hydrateCommitMeta(
  shas: string[],
): Promise<Map<string, CommitMeta>> {
  const out = new Map<string, CommitMeta>();
  if (shas.length === 0) return out;
  const fmt = ["%H", "%h", "%s", "%an", "%ae", "%aI"].join("%x1f");
  for (const sha of shas) {
    try {
      const raw = await runGitNoShell([
        "show",
        "-s",
        `--format=${fmt}`,
        sha,
      ]);
      const parts = raw.trim().split("\x1f");
      if (parts.length < 6) continue;
      const [full, _short, subject, an, ae, ai] = parts;
      if (!full || !subject || !ai) continue;
      out.set(full, {
        sha: full,
        short: shortSha(full),
        subject,
        authorName: an ?? "",
        authorEmail: ae ?? "",
        authoredAt: ai,
      });
    } catch {
      // Unknown SHA — may be from before this repo was cloned, or a
      // gone-from-refs prior deploy. Skip silently; the UI degrades
      // to "sha only, no metadata".
    }
  }
  return out;
}

// ── docker image presence ──────────────────────────────────────────

// We can't call dockerd from the api (no socket bind). Tag pruning
// in infra/deploy/tag-images.sh keeps only the most-recent
// IMAGE_RETENTION (=3) SHA tags per service, so we treat the manifest
// position as a strong proxy: position 0-2 = present, position 3+ =
// pruned by definition.
//
// A future tightening would be a small filtered docker-socket proxy
// for a real `image ls` lookup — out of scope here.
async function checkImages(
  manifests: Map<string, string[]>,
): Promise<Map<string, Set<string>>> {
  const present = new Map<string, Set<string>>();
  for (const [svc, shas] of manifests.entries()) {
    const set = new Set<string>();
    for (let i = 0; i < Math.min(shas.length, 3); i++) {
      const sha = shas[i];
      if (sha) set.add(sha);
    }
    present.set(svc, set);
  }
  return present;
}

function buildRollback(
  manifests: Map<string, string[]>,
  presence: Map<string, Set<string>>,
): RollbackTarget[] {
  const out: RollbackTarget[] = [];
  for (const [svc, shas] of manifests.entries()) {
    const here = presence.get(svc) ?? new Set<string>();
    const currentSha = shas[0] ?? null;
    const previousSha = shas[1] ?? null;
    out.push({
      service: svc,
      currentSha,
      currentShort: currentSha ? shortSha(currentSha) : null,
      currentImagePresent: currentSha ? here.has(currentSha) : false,
      previousSha,
      previousShort: previousSha ? shortSha(previousSha) : null,
      previousImagePresent: previousSha ? here.has(previousSha) : false,
      history: shas.map((sha) => ({
        sha,
        short: shortSha(sha),
        imagePresent: here.has(sha),
      })),
    });
  }
  // Sort for stable ordering — web1 first (it's what most deploys
  // touch), then alphabetical.
  out.sort((a, b) => {
    if (a.service === "web1") return -1;
    if (b.service === "web1") return 1;
    return a.service.localeCompare(b.service);
  });
  return out;
}

// ── file → service mapping ──────────────────────────────────────────
//
// Mirrors infra/deploy/detect-services.sh. Kept in sync by hand; the
// shell script remains the source of truth for the actual deploy.
// This duplication only powers the "what will rebuild" preview in
// the admin UI — if it drifts, the worst case is the UI shows a
// slightly wrong service set; the real `make deploy` always uses the
// shell version.
const ORDER = [
  "api",
  "ws-gateway",
  "web1",
  "signer",
  "feed-ingester",
  "odds-publisher",
  "settlement",
  "bet-delay",
  "wallet-watcher",
  "metrics-collector",
  "caddy",
];
const ALL_BUILT = ORDER.filter((s) => s !== "caddy");

function mapFilesToServices(files: string[]): string[] {
  const seen = new Set<string>();
  const mark = (...svcs: string[]) => svcs.forEach((s) => seen.add(s));

  for (const f of files) {
    if (f.startsWith("apps/web/")) mark("web1");
    else if (f.startsWith("services/api/")) mark("api");
    else if (f.startsWith("services/ws-gateway/")) mark("ws-gateway");
    else if (f.startsWith("services/feed-ingester/")) mark("feed-ingester");
    else if (f.startsWith("services/odds-publisher/")) mark("odds-publisher");
    else if (f.startsWith("services/settlement/")) mark("settlement");
    else if (f.startsWith("services/bet-delay/")) mark("bet-delay");
    else if (f.startsWith("services/wallet-watcher/")) mark("wallet-watcher");
    else if (f.startsWith("services/signer/")) mark("signer");
    else if (f.startsWith("services/metrics-collector/")) {
      mark("metrics-collector");
    } else if (f.startsWith("packages/auth/")) mark("api", "ws-gateway", "web1");
    else if (f.startsWith("packages/types/")) mark("api", "ws-gateway", "web1");
    else if (f.startsWith("packages/config/")) mark("api", "ws-gateway");
    else if (f.startsWith("packages/db/migrations/")) {
      // migration-only — no rebuild
    } else if (f.startsWith("packages/db/")) mark("api");
    else if (f === "Caddyfile") mark("caddy");
    else if (/^docker-compose(\.[\w-]+)?\.ya?ml$/.test(f)) {
      ALL_BUILT.forEach((s) => seen.add(s));
    } else if (
      f === "pnpm-lock.yaml" ||
      f === "package.json" ||
      f === "pnpm-workspace.yaml" ||
      f === "turbo.json"
    ) {
      mark("api", "ws-gateway", "web1");
    }
  }

  return ORDER.filter((s) => seen.has(s));
}

// ── helpers ─────────────────────────────────────────────────────────

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}
