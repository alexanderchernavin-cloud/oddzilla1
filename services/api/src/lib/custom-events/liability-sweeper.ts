// Liability trading for custom markets.
//
// Every pass repricing each open custom market that has trading switched
// on: exposure per outcome is recomputed from open tickets and blended
// into the operator's own probabilities, which shortens the side holding
// the money and lengthens the others. See
// packages/types/src/custom-events.ts for the arithmetic and why that
// direction is the profit-maximising one.
//
// **Deliberately a sweeper, not a hook inside bet placement.** Placement
// is the hottest money path in the system and it already runs a
// RRiskZilla evaluation, a wallet debit and a ledger write inside one
// transaction; adding a repricing to it would put the book's arithmetic
// on the critical path of taking a bet, and a failure there would fail
// the bet. Prices lagging the last bet by a few seconds costs nothing:
// placement re-reads and re-validates the authoritative price anyway, so
// a bettor clicking a stale cell is repriced or rejected, never filled at
// a price the book has moved off.
//
// Same shape as the other sweepers here: Redis NX lock so a three-replica
// api runs one pass, timers unref'd so they never hold the process open,
// every failure logged rather than thrown.

import type { FastifyInstance } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { customMarketConfig, markets, matches } from "@oddzilla/db";
import { repriceMarket } from "./pricing.js";

const LOCK_KEY = "custom-events:liability:lock";

/** Default cadence. Fast enough to follow a busy book, cheap enough to ignore. */
const DEFAULT_INTERVAL_MS = 20_000;

/**
 * Ceiling on markets repriced per pass. Custom events are hand-curated
 * and will not approach this, but an unbounded loop on a timer is how a
 * quiet feature becomes a database problem after somebody bulk-loads
 * something.
 */
const MAX_PER_PASS = 200;

export interface LiabilitySweeperHandle {
  close(): void;
}

function readIntervalMs(): number {
  const raw = Number(process.env.CUSTOM_LIABILITY_INTERVAL_SECONDS);
  if (Number.isFinite(raw) && raw >= 5) return raw * 1000;
  return DEFAULT_INTERVAL_MS;
}

export function startCustomLiabilitySweeper(
  app: FastifyInstance,
): LiabilitySweeperHandle | null {
  if (process.env.CUSTOM_LIABILITY_DISABLED === "1") {
    app.log.warn(
      { component: "custom-liability" },
      "custom-market liability trading disabled by CUSTOM_LIABILITY_DISABLED",
    );
    return null;
  }

  const intervalMs = readIntervalMs();
  const lockTtlS = Math.max(30, Math.floor((intervalMs / 1000) * 3));

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

      // EVERY open custom market, not only the liability-traded ones.
      //
      // Repricing is the single writer of custom prices and it is
      // deterministic: with trading off it is a pure function of the
      // operator's probabilities and overround, so a market nobody has
      // touched reprices to exactly what it already holds, writes
      // nothing, and publishes nothing. What that buys is self-healing —
      // when the pricing rule itself changes (the 0.01 quote ladder did,
      // and left every existing market showing 4.7619), the whole book
      // converges within one pass instead of waiting for an operator to
      // re-save each market by hand.
      //
      // Still only markets that are OPEN and on an unfinished event: a
      // settled or suspended market's prices are frozen by definition,
      // and repricing one would republish a price for a cell the
      // storefront has already locked.
      const rows = await app.db
        .select({ marketId: customMarketConfig.marketId })
        .from(customMarketConfig)
        .innerJoin(markets, eq(markets.id, customMarketConfig.marketId))
        .innerJoin(matches, eq(matches.id, markets.matchId))
        .where(
          and(
            eq(markets.status, 1),
            inArray(matches.status, ["not_started", "live"]),
          ),
        )
        .limit(MAX_PER_PASS);
      if (rows.length === 0) return;

      const started = Date.now();
      let moved = 0;
      let failed = 0;
      for (const r of rows) {
        try {
          const result = await repriceMarket(app, r.marketId);
          if (result?.moved) moved += 1;
        } catch (err) {
          failed += 1;
          app.log.warn(
            { err, component: "custom-liability", marketId: r.marketId.toString() },
            "repricing a custom market failed",
          );
        }
      }

      // Quiet unless something actually happened — this runs every 20 s.
      if (moved > 0 || failed > 0) {
        app.log.info(
          {
            component: "custom-liability",
            markets: rows.length,
            moved,
            failed,
            ms: Date.now() - started,
          },
          "custom-market liability sweep complete",
        );
      }
    } catch (err) {
      app.log.error(
        { err, component: "custom-liability" },
        "custom-market liability sweep failed",
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

  const bootTimer = setTimeout(() => void sweep(), 20_000);
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
