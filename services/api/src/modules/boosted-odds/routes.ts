// GET /catalog/matches/:matchId/boosted-odds — Custom Boosted Odds
// RULES for one match (migration 0085), resolved per market for the
// viewer. Prices are intentionally NOT in this payload: the match page
// computes boosted prices client-side with the shared boostMarketKey
// over the outcome set it already tracks via WS ticks, so the boost
// moves in the same render as the raw odds (true realtime). This
// endpoint only propagates admin rule changes and applies the
// per-viewer Min Risk Score gate — which can't ride the shared
// odds:match:{id} pub/sub channel precisely because it's per-user.
//
// Anonymous tolerated — the RS gate treats logged-out viewers as the
// default risk score (1.000), so a rule with minRiskScore <= 1 is
// public and a stricter threshold hides the boost until sign-in.
// Cache-Control: no-store — the payload varies per viewer.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { categories, markets, matches, tournaments } from "@oddzilla/db";
import type { CustomBoostedMarket, CustomBoostedOddsResponse } from "@oddzilla/types";
import {
  loadBoostRulesForMatch,
  loadViewerRiskScore,
  passesRiskGate,
  resolveBoostForMarket,
} from "../../lib/boosted-odds.js";

const paramsSchema = z.object({ matchId: z.coerce.bigint() });

const EMPTY = (): CustomBoostedOddsResponse => ({
  entries: [],
  serverNow: new Date().toISOString(),
});

export default async function boostedOddsRoutes(app: FastifyInstance) {
  app.get("/catalog/matches/:matchId/boosted-odds", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const { matchId } = paramsSchema.parse(request.params);

    const [match] = await app.db
      .select({
        id: matches.id,
        status: matches.status,
        tournamentId: matches.tournamentId,
        sportId: categories.sportId,
        homeCompetitorId: matches.homeCompetitorId,
        awayCompetitorId: matches.awayCompetitorId,
      })
      .from(matches)
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .where(eq(matches.id, matchId))
      .limit(1);
    if (!match || (match.status !== "not_started" && match.status !== "live")) {
      return EMPTY();
    }

    const rules = await loadBoostRulesForMatch(app.db, {
      matchId: match.id,
      tournamentId: match.tournamentId,
      sportId: match.sportId,
      homeCompetitorId: match.homeCompetitorId,
      awayCompetitorId: match.awayCompetitorId,
    });
    if (rules.length === 0) return EMPTY();

    const riskScore = await loadViewerRiskScore(app.db, request.user?.id);
    const eligible = rules.filter((r) => passesRiskGate(r, riskScore));
    if (eligible.length === 0) return EMPTY();

    // Resolve the winning rule per active market. No outcome loading —
    // the client prices against its own live outcome state.
    const marketRows = await app.db
      .select({ id: markets.id })
      .from(markets)
      .where(and(eq(markets.matchId, matchId), eq(markets.status, 1)));
    const entries: CustomBoostedMarket[] = [];
    for (const m of marketRows) {
      const rule = resolveBoostForMarket(eligible, m.id);
      if (!rule) continue;
      entries.push({
        ruleId: rule.id,
        marketId: m.id.toString(),
        boostPct: rule.boostPct,
        endsAt: rule.endsAt?.toISOString() ?? null,
      });
    }

    return {
      entries,
      serverNow: new Date().toISOString(),
    } satisfies CustomBoostedOddsResponse;
  });
}
