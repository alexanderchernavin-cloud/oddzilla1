// Pricing and publishing for custom (operator-authored) markets.
//
// One function does the writing — `repriceMarket` — and both callers use
// it: the backoffice when an operator saves, and the liability sweeper
// when bets move the book. Keeping a single writer is what stops the two
// paths from disagreeing about what a market currently costs.
//
// The arithmetic itself is in @oddzilla/types/custom-events, shared with
// the admin UI so its live preview and this save cannot drift.

import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import {
  customMarketConfig,
  customOutcomeConfig,
  marketOutcomes,
  markets,
  matches,
  tournaments,
  categories,
} from "@oddzilla/db";
import {
  CUSTOM_PROVIDER_MARKET_ID,
  CUSTOM_SPECIFIER_KEY,
  priceCustomMarket,
  type CustomPriceCell,
} from "@oddzilla/types/custom-events";
import { canonical } from "@oddzilla/types/specifiers";

/**
 * Exposure per outcome, in micro units: what the book would owe if that
 * outcome won, across every OPEN ticket touching this market.
 *
 * A combo's payout is contingent on its other legs, so charging the whole
 * potential payout to each leg would multiply the book's real exposure by
 * the number of legs. This uses the same net-win share RiskZilla's
 * liability caps use — leg `i` carries `payout × (odds_i − 1) / Σ(odds_j − 1)`
 * — so the two views of "how exposed are we here" agree. A single has one
 * leg and therefore carries its whole payout, which is the intuitive case.
 *
 * **USDC only.** OZ is the demo currency handed out free at signup; if it
 * counted here, a bettor could move real prices with play money. The same
 * reasoning fences OZ out of RiskZilla's bank counters.
 */
export async function loadExposureByOutcome(
  db: FastifyInstance["db"],
  marketId: bigint,
): Promise<Map<string, number>> {
  const rows = await db.execute<{ outcome_id: string; exposure_micro: string }>(sql`
    WITH touched AS (
      SELECT DISTINCT ticket_id
        FROM ticket_selections
       WHERE market_id = ${marketId}
    ),
    legs AS (
      SELECT ts.ticket_id,
             ts.market_id,
             ts.outcome_id,
             t.potential_payout_micro,
             -- Net-win weight. Floored just above zero so a leg priced at
             -- exactly 1.00 still carries a share rather than making the
             -- whole ticket's denominator zero.
             GREATEST(ts.odds_at_placement - 1, 0.0001) AS nw
        FROM ticket_selections ts
        JOIN touched g ON g.ticket_id = ts.ticket_id
        JOIN tickets t ON t.id = ts.ticket_id
       WHERE t.status IN ('pending_delay', 'accepted')
         AND TRIM(t.currency) = 'USDC'
    ),
    shares AS (
      SELECT l.*, SUM(l.nw) OVER (PARTITION BY l.ticket_id) AS nw_total
        FROM legs l
    )
    SELECT outcome_id,
           COALESCE(SUM(potential_payout_micro * nw / NULLIF(nw_total, 0)), 0)::bigint::text
             AS exposure_micro
      FROM shares
     WHERE market_id = ${marketId}
     GROUP BY outcome_id
  `);
  const out = new Map<string, number>();
  for (const r of rows) {
    out.set(r.outcome_id, Number(r.exposure_micro));
  }
  return out;
}

export interface RepricedMarket {
  marketId: bigint;
  matchId: bigint;
  cells: CustomPriceCell[];
  /** True when liability trading actually moved a price this pass. */
  moved: boolean;
}

/**
 * Recompute and persist one custom market's prices.
 *
 * Reads the operator's base probabilities and settings, folds in current
 * exposure when liability trading is on, writes `market_outcomes`, and
 * pushes a WS tick per outcome so open tabs re-price without a reload.
 *
 * Returns null when the market has no custom config (not a custom market,
 * or its config row was deleted) or fewer than two configured outcomes —
 * both are "nothing to do", not errors.
 */
export async function repriceMarket(
  app: FastifyInstance,
  marketId: bigint,
): Promise<RepricedMarket | null> {
  const [cfg] = await app.db
    .select({
      marketId: customMarketConfig.marketId,
      overroundBp: customMarketConfig.overroundBp,
      liabilityTrading: customMarketConfig.liabilityTrading,
      liabilityStrengthBp: customMarketConfig.liabilityStrengthBp,
      liabilityMaxShiftBp: customMarketConfig.liabilityMaxShiftBp,
      matchId: markets.matchId,
      status: markets.status,
      specifiersJson: markets.specifiersJson,
      sportId: categories.sportId,
      tournamentId: tournaments.id,
    })
    .from(customMarketConfig)
    .innerJoin(markets, eq(markets.id, customMarketConfig.marketId))
    .innerJoin(matches, eq(matches.id, markets.matchId))
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .innerJoin(categories, eq(categories.id, tournaments.categoryId))
    .where(eq(customMarketConfig.marketId, marketId))
    .limit(1);
  if (!cfg) return null;

  const outcomeRows = await app.db
    .select({
      outcomeId: customOutcomeConfig.outcomeId,
      baseProbability: customOutcomeConfig.baseProbability,
      sortOrder: customOutcomeConfig.sortOrder,
    })
    .from(customOutcomeConfig)
    .where(eq(customOutcomeConfig.marketId, marketId));
  if (outcomeRows.length < 2) return null;
  outcomeRows.sort(
    (a, b) => a.sortOrder - b.sortOrder || a.outcomeId.localeCompare(b.outcomeId),
  );

  // Exposure is only read when it can change the answer. A market with
  // trading off pays for no query.
  const exposure = cfg.liabilityTrading
    ? await loadExposureByOutcome(app.db, marketId)
    : new Map<string, number>();

  const cells = priceCustomMarket({
    outcomes: outcomeRows.map((o) => ({
      outcomeId: o.outcomeId,
      baseProbability: Number(o.baseProbability),
      exposureMicro: exposure.get(o.outcomeId) ?? 0,
    })),
    overroundBp: cfg.overroundBp,
    liability: {
      enabled: cfg.liabilityTrading,
      strengthBp: cfg.liabilityStrengthBp,
      maxShiftBp: cfg.liabilityMaxShiftBp,
    },
  });

  // Read the current prices first so the tick fan-out only fires for
  // outcomes that actually moved. Repricing runs on a timer; publishing
  // an unchanged price every pass would be pure noise on a channel the
  // storefront treats as "something changed".
  const current = await app.db
    .select({
      outcomeId: marketOutcomes.outcomeId,
      publishedOdds: marketOutcomes.publishedOdds,
      active: marketOutcomes.active,
    })
    .from(marketOutcomes)
    .where(eq(marketOutcomes.marketId, marketId));
  const currentByOutcome = new Map(current.map((c) => [c.outcomeId, c]));

  const changed: CustomPriceCell[] = [];
  await app.db.transaction(async (tx) => {
    for (const cell of cells) {
      const before = currentByOutcome.get(cell.outcomeId);
      const published = cell.publishedOdds.toFixed(4);
      if (!before || before.publishedOdds !== published) changed.push(cell);
      await tx
        .update(marketOutcomes)
        .set({
          rawOdds: cell.rawOdds.toFixed(4),
          publishedOdds: published,
          probability: cell.probability.toFixed(7),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(marketOutcomes.marketId, marketId),
            eq(marketOutcomes.outcomeId, cell.outcomeId),
          ),
        );
    }
    await tx
      .update(customMarketConfig)
      .set({ liabilityPricedAt: new Date(), updatedAt: new Date() })
      .where(eq(customMarketConfig.marketId, marketId));
  });

  // Only a market the storefront is currently offering gets ticks. A
  // suspended or settled market's cell is already locked client-side, and
  // a price tick would unlock it.
  if (cfg.status === 1) {
    const specs = (cfg.specifiersJson ?? {}) as Record<string, string>;
    for (const cell of changed) {
      const active = currentByOutcome.get(cell.outcomeId)?.active ?? true;
      await publishOddsTick(app, {
        matchId: cfg.matchId,
        marketId,
        sportId: cfg.sportId,
        tournamentId: cfg.tournamentId,
        specifiers: canonical(specs),
        outcomeId: cell.outcomeId,
        publishedOdds: cell.publishedOdds.toFixed(4),
        probability: cell.probability.toFixed(7),
        active,
      });
    }
  }

  return { marketId, matchId: cfg.matchId, cells, moved: changed.length > 0 };
}

/**
 * Push one price onto `odds:match:{id}`.
 *
 * Shape-identical to what odds-publisher (Go) emits — ws-gateway forwards
 * the JSON verbatim, so the storefront's existing `odds` branch handles
 * it with no client change. `sportId` / `tournamentId` are what let
 * ws-gateway resolve a per-bettor odds adjustment without a DB lookup, so
 * they are not optional in practice even though the client ignores them.
 */
export async function publishOddsTick(
  app: FastifyInstance,
  tick: {
    matchId: bigint;
    marketId: bigint;
    sportId: number;
    tournamentId: number;
    specifiers: string;
    outcomeId: string;
    publishedOdds: string;
    probability: string;
    active: boolean;
  },
): Promise<void> {
  const payload = {
    type: "odds",
    matchId: tick.matchId.toString(),
    marketId: tick.marketId.toString(),
    providerMarketId: CUSTOM_PROVIDER_MARKET_ID,
    sportId: tick.sportId,
    tournamentId: tick.tournamentId,
    specifiers: tick.specifiers,
    outcomeId: tick.outcomeId,
    publishedOdds: tick.publishedOdds,
    probability: tick.probability,
    active: tick.active,
    ts: new Date().toISOString(),
  };
  // Best-effort: pub/sub is the fanout, Postgres is the source of truth
  // (CLAUDE.md invariant 7). A failed publish costs a stale price until
  // the viewer's next navigation, never a wrong stored price.
  await app.redis
    .publish(`odds:match:${tick.matchId}`, JSON.stringify(payload))
    .catch(() => null);
}

/** Push a market-status change so open tabs lock or unlock the cell. */
export async function publishMarketStatus(
  app: FastifyInstance,
  args: { matchId: bigint; marketId: bigint; status: number },
): Promise<void> {
  const payload = {
    type: "marketStatus",
    matchId: args.matchId.toString(),
    marketId: args.marketId.toString(),
    status: args.status,
    ts: new Date().toISOString(),
  };
  await app.redis
    .publish(`odds:match:${args.matchId}`, JSON.stringify(payload))
    .catch(() => null);
}

/** The specifier map that identifies one custom market on its event. */
export function customSpecifiers(key: string): Record<string, string> {
  return { [CUSTOM_SPECIFIER_KEY]: key };
}
