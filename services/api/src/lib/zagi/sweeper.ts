// Background ZillaAGI risk-tier review.
//
// New tournaments arrive continuously — Fonbet publishes a fresh country
// bucket whenever a season starts, and every one of them lands with
// `risk_tier` NULL. NULL prices at UNTIERED_RISK_TIER = 10, so the book
// is never exposed by a gap; what it is instead is invisible, and a
// competition that should be taking 10 000 USDC a match quietly takes
// 50 until somebody notices. This is the "somebody notices" part, so the
// backlog cannot rebuild itself behind the operator's back.
//
// It is also what drains the initial 1 231-row backlog: each pass takes
// a bounded slice, so the queue empties over a few hours rather than in
// one long request storm, and an operator who wants it now has the Run
// button on /admin/tournaments.
//
// Same shape as the other sweepers in this service: Redis NX lock so a
// three-replica api still runs one pass, timers unref'd so they never
// hold the process open, every failure logged rather than thrown.

import type { FastifyInstance } from "fastify";
import { assignRiskTiers } from "./risk-tier.js";
import { zagiConfigFromEnv } from "./client.js";

const LOCK_KEY = "zagi:risk-tier:lock";

/**
 * Rows per pass. Sized so one sweep is a couple of minutes of model time
 * (25 per request, ~15 s per request) rather than a quarter of an hour.
 */
const PER_SWEEP = 200;

export interface ZagiRiskTierSweeperHandle {
  close(): void;
}

function readIntervalMs(): number {
  const raw = Number(process.env.ZAGI_RISK_TIER_INTERVAL_MINUTES);
  const minutes = Number.isFinite(raw) && raw >= 5 ? raw : 30;
  return minutes * 60_000;
}

export function startZagiRiskTierSweeper(
  app: FastifyInstance,
): ZagiRiskTierSweeperHandle | null {
  if (process.env.ZAGI_RISK_TIER_DISABLED === "1") {
    app.log.warn(
      { component: "zagi-risk-tier" },
      "tournament risk-tier review disabled by ZAGI_RISK_TIER_DISABLED",
    );
    return null;
  }
  if (!zagiConfigFromEnv()) {
    // Graceful-idle. Without a key there is nothing to call, and an
    // untiered tournament stays at the strictest tier — which is safe,
    // just conservative.
    app.log.warn(
      { component: "zagi-risk-tier" },
      "tournament risk-tier review idle: no ZAGI_API_KEY configured",
    );
    return null;
  }

  const intervalMs = readIntervalMs();
  const lockTtlS = Math.max(300, Math.floor((intervalMs / 1000) * 0.8));

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
      const result = await assignRiskTiers(app, { limit: PER_SWEEP });

      // Silence when there was nothing to do — this runs every 30 min
      // and a quiet log is what makes the noisy one legible.
      if (result.eligible > 0 || result.errors.length > 0) {
        app.log.info(
          {
            component: "zagi-risk-tier",
            model: result.model,
            eligible: result.eligible,
            reviewed: result.reviewed,
            assigned: result.assigned,
            clamped: result.clamped,
            undecided: result.undecided,
            batches: result.batches,
            errors: result.errors.length,
            ms: Date.now() - started,
          },
          "zagi tournament risk-tier sweep complete",
        );
      }
      for (const err of result.errors.slice(0, 3)) {
        app.log.warn({ component: "zagi-risk-tier", err }, "risk-tier batch failed");
      }
    } catch (err) {
      app.log.error(
        { err, component: "zagi-risk-tier" },
        "zagi tournament risk-tier sweep failed",
      );
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

  // Boot delay keeps the first pass clear of a deploy's opening requests
  // and staggers the api replicas past one another.
  const bootTimer = setTimeout(() => void sweep(), 90_000);
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
