// Admin /monitoring endpoints + background sampler.
//
// Two endpoints:
//
//   GET /admin/monitoring/snapshot
//     Live point-in-time JSON. Proxies the metrics-collector container.
//     Polled every ~5 s by the admin page so the KPI cards stay fresh.
//
//   GET /admin/monitoring/history?hours=N (1..24)
//     Time-series for the line charts. Reads from the
//     `monitoring:samples` Redis sorted set populated by the sampler
//     below.
//
// Sampler:
//
//   Every 60 s a single api instance acquires a Redis lock
//   (`monitoring:sampler:lock`, NX EX 90), fetches a snapshot from the
//   metrics-collector, projects it into a compact { ts, diskPct,
//   memPct, swapPct, cpuPct, load1, containers{healthy,total} } row,
//   and ZADDs it to the sorted set keyed by unix timestamp. After
//   each write it ZREMRANGEBYSCORE-trims everything older than 24 h.
//
//   With one api container today, this is "the api samples". When we
//   horizontally scale the api, the lock guarantees only one container
//   writes per minute; the others fail-acquire and skip without
//   error. The lock TTL > sample interval so a crash + restart can't
//   produce a thundering herd.
//
// Graceful idle:
//
//   If the metrics-collector container is down or the URL is wrong,
//   /snapshot returns 503 monitoring_unavailable and the sampler
//   silently skips that minute (logs a warn, no Redis write). The
//   admin page renders "metrics unavailable" without crashing —
//   same graceful-idle pattern Disir + OBB use.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadEnv } from "@oddzilla/config";
import { ServiceUnavailableError } from "../../lib/errors.js";

// Compact projection stored per sample. Keep this lean — we keep 24 h
// at 1/min = 1440 rows × ~120 B = ~170 KB; bigger projections grow
// Redis memory linearly. CPU% is nullable because the collector
// returns null on its very first call after process start.
interface SampleRow {
  ts: number;
  diskPct: number;
  memPct: number;
  swapPct: number;
  cpuPct: number | null;
  load1: number;
  containersHealthy: number;
  containersTotal: number;
}

interface HostSnapshot {
  uptimeSec: number;
  cpuCount: number;
  loadAvg: { m1: number; m5: number; m15: number };
  cpuPct: number | null;
  memory: { totalBytes: number; usedBytes: number; freeBytes: number; usedPct: number };
  swap: { totalBytes: number; usedBytes: number; usedPct: number };
  disk: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usedPct: number;
  };
}

interface ContainerSnapshot {
  name: string;
  image: string;
  state: string;
  status: string;
  health: "healthy" | "unhealthy" | "starting" | "none";
  createdAt: number;
}

interface CollectorSnapshot {
  ts: number;
  host: HostSnapshot;
  containers: ContainerSnapshot[];
}

const SAMPLES_KEY = "monitoring:samples";
const SAMPLER_LOCK_KEY = "monitoring:sampler:lock";
const SAMPLER_LOCK_TTL_S = 90;
const SAMPLE_INTERVAL_MS = 60_000;
const HISTORY_RETENTION_S = 24 * 60 * 60;
// metrics-collector calls are bounded — if dockerd is wedged the
// collector's own 3 s docker timeout fires first. We add a small
// margin so a slow node + slow docker still completes.
const COLLECTOR_TIMEOUT_MS = 5_000;

const historyQuery = z.object({
  hours: z.coerce.number().int().min(1).max(24).default(24),
});

async function fetchSnapshot(): Promise<CollectorSnapshot> {
  const env = loadEnv();
  const url = `${env.METRICS_COLLECTOR_URL.replace(/\/+$/, "")}/snapshot`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), COLLECTOR_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) {
      throw new ServiceUnavailableError(
        `metrics-collector returned ${resp.status}`,
        "monitoring_unavailable",
      );
    }
    return (await resp.json()) as CollectorSnapshot;
  } catch (err) {
    if (err instanceof ServiceUnavailableError) throw err;
    throw new ServiceUnavailableError(
      `metrics-collector unreachable: ${err instanceof Error ? err.message : String(err)}`,
      "monitoring_unavailable",
    );
  } finally {
    clearTimeout(timer);
  }
}

function compact(snapshot: CollectorSnapshot): SampleRow {
  const containers = snapshot.containers ?? [];
  const total = containers.length;
  const healthy = containers.filter(
    (c) => c.state === "running" && (c.health === "healthy" || c.health === "none"),
  ).length;
  return {
    ts: snapshot.ts,
    diskPct: snapshot.host.disk.usedPct,
    memPct: snapshot.host.memory.usedPct,
    swapPct: snapshot.host.swap.usedPct,
    cpuPct: snapshot.host.cpuPct ?? null,
    load1: snapshot.host.loadAvg.m1,
    containersHealthy: healthy,
    containersTotal: total,
  };
}

export default async function adminMonitoringRoutes(app: FastifyInstance) {
  app.get("/admin/monitoring/snapshot", async (request) => {
    request.requireRole("admin");
    return await fetchSnapshot();
  });

  app.get("/admin/monitoring/history", async (request) => {
    request.requireRole("admin");
    const q = historyQuery.parse(request.query ?? {});
    const cutoff = Math.floor(Date.now() / 1000) - q.hours * 3600;

    const rows = await app.redis.zrangebyscore(
      SAMPLES_KEY,
      cutoff,
      "+inf",
      "WITHSCORES",
    );
    // ioredis returns [member, score, member, score, ...] in score-asc
    // order. We discard the duplicate score (member already encodes ts).
    const samples: SampleRow[] = [];
    for (let i = 0; i < rows.length; i += 2) {
      const member = rows[i];
      if (typeof member !== "string") continue;
      try {
        samples.push(JSON.parse(member) as SampleRow);
      } catch {
        // Bad row — skip, don't poison the whole response.
      }
    }
    return { samples };
  });
}

// startMonitoringSampler is wired up from server.ts. It returns a
// stop function so SIGTERM handlers can cancel cleanly. The sampler
// catches every error so a transient collector outage doesn't unhandle
// a promise; failures are warn-logged and the loop keeps running.
export function startMonitoringSampler(app: FastifyInstance): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  // A fresh per-process token so the lock owner is identifiable in a
  // future multi-instance deploy. crypto.randomUUID is on Node 22+.
  const ownerToken = `${process.pid}:${crypto.randomUUID()}`;

  async function tick() {
    if (stopped) return;
    try {
      // SET NX EX — only one api instance writes per minute. ioredis
      // accepts the redis-cli-style trailing flags.
      const acquired = await app.redis.set(
        SAMPLER_LOCK_KEY,
        ownerToken,
        "EX",
        SAMPLER_LOCK_TTL_S,
        "NX",
      );
      if (acquired === "OK") {
        const snapshot = await fetchSnapshot();
        const sample = compact(snapshot);
        const ts = sample.ts || Math.floor(Date.now() / 1000);
        // Same ts twice in one process = same member → ZADD is a no-op,
        // which is fine. The collector's TS comes from time.Now() so a
        // duplicate is essentially impossible at minute cadence.
        await app.redis.zadd(SAMPLES_KEY, ts, JSON.stringify(sample));
        await app.redis.zremrangebyscore(
          SAMPLES_KEY,
          "-inf",
          ts - HISTORY_RETENTION_S,
        );
        app.log.debug({ event: "monitoring.sample", sample }, "sampled");
      } else {
        app.log.debug(
          { event: "monitoring.sample.skip" },
          "sampler lock held by another instance",
        );
      }
    } catch (err) {
      app.log.warn({ err, event: "monitoring.sample.failed" }, "sample failed");
    } finally {
      if (!stopped) timer = setTimeout(tick, SAMPLE_INTERVAL_MS);
    }
  }

  // First tick fires after a short delay so the api has finished
  // booting (db/redis pings, warm caches). 5 s also keeps server
  // start-up logs uncluttered.
  timer = setTimeout(tick, 5_000);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
