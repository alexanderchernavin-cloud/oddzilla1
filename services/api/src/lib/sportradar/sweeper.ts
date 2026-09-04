// Background Sportradar mapping sweep.
//
// Fixtures arrive continuously — Fonbet publishes days ahead and Oddin
// adds matches through the day — so a mapping built by hand is stale by
// the next morning, and the Live Match Tracker silently stops appearing
// on new matches. This keeps it current without anyone pressing
// anything; the admin Sync button is the same pipeline for when an
// operator wants it now.
//
// Cost is deliberately small: `syncSports` only fetches the days our own
// open matches actually fall on, so a sport with nothing to map costs
// zero requests, and a full pass over the ~17 covered sports is a few
// dozen cached-at-the-edge GETs. Everything else is one indexed query
// per sport plus the matcher, which is pure CPU over a few thousand
// rows.
//
// Same shape as the other sweepers in this service: Redis NX lock so a
// multi-replica api still runs one pass, timers unref'd so they never
// hold the process open, and every failure logged rather than thrown.

import type { FastifyInstance } from "fastify";
import { lmtSportSlugs, syncSports } from "./sync.js";
import { adjudicateCandidates, adjudicatorConfigFromEnv } from "./adjudicator.js";

const LOCK_KEY = "sportradar:sync:lock";
// Per sweep. A backlog drains over successive passes rather than in one
// long burst of requests.
const ADJUDICATE_PER_SWEEP = 150;

export interface SportradarSweeperHandle {
  close(): void;
}

function readIntervalMs(): number {
  const raw = Number(process.env.SPORTRADAR_SYNC_INTERVAL_MINUTES);
  // 30 minutes is comfortably inside the 8-day pairing window, so a
  // fixture is mapped long before anyone can open its page live.
  const minutes = Number.isFinite(raw) && raw >= 5 ? raw : 30;
  return minutes * 60_000;
}

export function startSportradarSyncSweeper(
  app: FastifyInstance,
): SportradarSweeperHandle | null {
  if (process.env.SPORTRADAR_SYNC_DISABLED === "1") {
    app.log.warn(
      { component: "sportradar-sync" },
      "sportradar mapping sweep disabled by SPORTRADAR_SYNC_DISABLED",
    );
    return null;
  }

  const intervalMs = readIntervalMs();
  // The lock must outlive a slow pass but not a crashed one.
  const lockTtlS = Math.max(120, Math.floor((intervalMs / 1000) * 0.8));

  const sweep = async () => {
    let locked = false;
    try {
      const acquired = await app.redis.set(
        LOCK_KEY,
        `${process.pid}:${Date.now()}`,
        "EX",
        lockTtlS,
        "NX",
      );
      if (!acquired) return;
      locked = true;

      const started = Date.now();
      const result = await syncSports(app, {
        sportSlugs: lmtSportSlugs(),
        dryRun: false,
        // No audit row: admin_audit_log records what an ADMIN did.
      });

      if (result.written > 0 || result.fetchErrors.length > 0) {
        app.log.info(
          {
            component: "sportradar-sync",
            proposed: result.proposed,
            autoConfirmed: result.autoConfirmed,
            written: result.written,
            sports: result.sports.length,
            fetchErrors: result.fetchErrors.length,
            ms: Date.now() - started,
          },
          "sportradar mapping sweep complete",
        );
      }
      for (const err of result.fetchErrors.slice(0, 5)) {
        app.log.warn({ component: "sportradar-sync", err }, "sportradar fixture fetch failed");
      }

      // Adjudicate whatever the matcher could not settle. Skipped
      // silently when no model is configured — the queue then stays
      // human-reviewed, which is the pre-existing behaviour.
      if (adjudicatorConfigFromEnv()) {
        const adj = await adjudicateCandidates(app, { limit: ADJUDICATE_PER_SWEEP });
        if (adj.reviewed > 0 || adj.errors.length > 0) {
          app.log.info(
            {
              component: "sportradar-adjudicator",
              eligible: adj.eligible,
              reviewed: adj.reviewed,
              confirmed: adj.confirmed,
              rejected: adj.rejected,
              unsure: adj.unsure,
              batches: adj.batches,
              errors: adj.errors.length,
            },
            "sportradar candidate adjudication complete",
          );
        }
        for (const err of adj.errors.slice(0, 3)) {
          app.log.warn({ component: "sportradar-adjudicator", err }, "adjudication batch failed");
        }
      }
    } catch (err) {
      app.log.error({ err, component: "sportradar-sync" }, "sportradar mapping sweep failed");
    } finally {
      if (locked) {
        try {
          await app.redis.del(LOCK_KEY);
        } catch {
          // TTL releases it.
        }
      }
    }
  };

  // Boot delay keeps the sweep out of the way of a deploy's first
  // requests, and staggers the three api replicas past each other.
  const bootTimer = setTimeout(() => void sweep(), 60_000);
  bootTimer.unref?.();
  const timer = setInterval(() => void sweep(), intervalMs);
  timer.unref?.();

  return {
    close() {
      clearTimeout(bootTimer);
      clearInterval(timer);
    },
  };
}
