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
 * Rows per call into the reviewer. Small enough that a pass makes visible
 * progress early and a crash loses little.
 */
const CHUNK = 200;

/**
 * How long one sweep may keep going while a backlog remains.
 *
 * A fixed rows-per-sweep cap is the wrong shape for the initial 1 231-row
 * backlog: at 200 every 30 minutes it would take three and a half hours to
 * work through a queue the model can actually clear in about ten minutes.
 * So a sweep keeps taking chunks until the queue is empty or this budget
 * is spent, and in the steady state — a handful of new tournaments — it
 * finishes on the first chunk and costs nothing.
 */
const SWEEP_BUDGET_MS = 10 * 60_000;

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
  // Must outlive a full-budget sweep, or a second replica picks up the
  // lock while the first is still working through the backlog. The floor
  // is the budget plus slack, not a fraction of the interval — at the
  // 5-minute minimum interval those are very different numbers.
  const lockTtlS = Math.max(
    Math.floor(SWEEP_BUDGET_MS / 1000) + 120,
    Math.floor((intervalMs / 1000) * 0.8),
  );

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
      const total = {
        eligible: 0,
        reviewed: 0,
        assigned: 0,
        clamped: 0,
        undecided: 0,
        batches: 0,
        chunks: 0,
      };
      const errors: string[] = [];
      let model: string | null = null;

      while (Date.now() - started < SWEEP_BUDGET_MS) {
        const result = await assignRiskTiers(app, { limit: CHUNK });
        model = result.model;
        total.chunks += 1;
        total.eligible += result.eligible;
        total.reviewed += result.reviewed;
        total.assigned += result.assigned;
        total.clamped += result.clamped;
        total.undecided += result.undecided;
        total.batches += result.batches;
        errors.push(...result.errors);

        // Queue drained.
        if (result.eligible === 0) break;
        // No progress — every batch failed in transport, which burns no
        // attempt, so looping would just repeat the same failure until
        // the budget ran out. Leave it for the next sweep.
        if (result.reviewed === 0 && result.undecided === 0) break;
      }

      // Silence when there was nothing to do — this runs every 30 min
      // and a quiet log is what makes the noisy one legible.
      if (total.eligible > 0 || errors.length > 0) {
        app.log.info(
          {
            component: "zagi-risk-tier",
            model,
            chunks: total.chunks,
            eligible: total.eligible,
            reviewed: total.reviewed,
            assigned: total.assigned,
            clamped: total.clamped,
            undecided: total.undecided,
            batches: total.batches,
            errors: errors.length,
            ms: Date.now() - started,
          },
          "zagi tournament risk-tier sweep complete",
        );
      }
      for (const err of errors.slice(0, 3)) {
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
