// Background tournament-logo sourcing.
//
// Paced rather than bounded by row count: Liquipedia asks for at least
// 2 s between API calls and a tournament can cost several lookups (a
// canonical title plus up to two aliases, each needing a page read and
// an image read). A fixed rows-per-sweep number would either idle or
// blow through their rate limit depending on the mix of sports, so the
// sweep runs to a TIME budget and the client serialises the calls.
//
// New tournaments arrive constantly and most of them are weekly duel
// cups with no logo anywhere, which is why `logo_attempts` exists: three
// misses and a row stops being asked about. Without that the sweep would
// spend its whole budget re-checking the same unfindable rows forever.

import type { FastifyInstance } from "fastify";
import { resolveTournamentLogos } from "./resolver.js";
import { zagiConfigFromEnv } from "../zagi/client.js";

const LOCK_KEY = "tournament-logos:sweep:lock";
const CHUNK = 40;
const SWEEP_BUDGET_MS = 10 * 60_000;

export interface TournamentLogoSweeperHandle {
  close(): void;
}

function readIntervalMs(): number {
  const raw = Number(process.env.TOURNAMENT_LOGO_INTERVAL_MINUTES);
  const minutes = Number.isFinite(raw) && raw >= 10 ? raw : 60;
  return minutes * 60_000;
}

export function startTournamentLogoSweeper(
  app: FastifyInstance,
): TournamentLogoSweeperHandle | null {
  if (process.env.TOURNAMENT_LOGO_SWEEPER_DISABLED === "1") {
    app.log.warn(
      { component: "tournament-logos" },
      "tournament logo sourcing disabled by TOURNAMENT_LOGO_SWEEPER_DISABLED",
    );
    return null;
  }
  if (!zagiConfigFromEnv()) {
    // The canonical-name step is the whole front half; without it there
    // is nothing to look up.
    app.log.warn(
      { component: "tournament-logos" },
      "tournament logo sourcing idle: no ZAGI_API_KEY configured",
    );
    return null;
  }

  const intervalMs = readIntervalMs();
  // The lock only has to outlive ONE sweep. Sizing it off the interval
  // instead — max(budget, interval * 0.8) — made it 48 minutes for the
  // hourly default, so a sweep killed mid-run by a deploy blocked the
  // next one for most of an hour. That is exactly what happened on the
  // first production run: the deploy that shipped this replaced the api
  // mid-sweep, the lock survived its holder, and the next pass returned
  // silently. Cadence is the interval timer's job, not the lock's.
  const lockTtlS = Math.floor(SWEEP_BUDGET_MS / 1000) + 120;

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
      if (!acquired) {
        // Worth a line: a held lock is indistinguishable from a sweeper
        // that never started, and chasing that difference through an
        // otherwise silent log cost real time once already.
        app.log.info(
          { component: "tournament-logos" },
          "logo sweep skipped: another pass holds the lock",
        );
        return;
      }
      locked = true;

      const started = Date.now();
      const total = { eligible: 0, named: 0, declined: 0, unmatched: 0, applied: 0, chunks: 0 };
      const errors: string[] = [];

      while (Date.now() - started < SWEEP_BUDGET_MS) {
        const r = await resolveTournamentLogos(app, { limit: CHUNK });
        total.chunks += 1;
        total.eligible += r.eligible;
        total.named += r.named;
        total.declined += r.declined;
        total.unmatched += r.unmatched;
        total.applied += r.applied;
        errors.push(...r.errors);
        if (r.rateLimited) {
          app.log.warn(
            { component: "tournament-logos" },
            "logo sweep stopped early: Liquipedia rate-limited us",
          );
          break;
        }
        if (r.eligible === 0) break;
        // No progress at all means every batch failed in transport,
        // which burns no attempt — looping would just repeat it.
        if (r.named === 0 && r.declined === 0) break;
      }

      if (total.eligible > 0 || errors.length > 0) {
        app.log.info(
          {
            component: "tournament-logos",
            chunks: total.chunks,
            eligible: total.eligible,
            named: total.named,
            declined: total.declined,
            unmatched: total.unmatched,
            applied: total.applied,
            errors: errors.length,
            ms: Date.now() - started,
          },
          "tournament logo sweep complete",
        );
      }
      for (const err of errors.slice(0, 3)) {
        app.log.warn({ component: "tournament-logos", err }, "logo lookup failed");
      }
    } catch (err) {
      app.log.error({ err, component: "tournament-logos" }, "tournament logo sweep failed");
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

  const bootTimer = setTimeout(() => void sweep(), 150_000);
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
