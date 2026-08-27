// GET /catalog/matches/:matchId/boosted-odds — Custom Boosted Odds
// RULES for one match (migration 0085; outcome scope 0087-0088),
// resolved per market for the viewer. Prices are intentionally NOT in
// this payload: the match page computes boosted prices client-side with
// the shared quoteMarketBoost over the outcome set it already tracks via
// WS ticks, so the boost moves in the same render as the raw odds (true
// realtime). This endpoint only propagates admin rule changes and
// applies the per-viewer Min Risk Score gate — which can't ride the
// shared odds:match:{id} pub/sub channel precisely because it's
// per-user.
//
// Anonymous tolerated — the RS gate treats logged-out viewers as the
// default risk score (1.000), so a rule with minRiskScore <= 1 is
// public and a stricter threshold hides the boost until sign-in.
// Cache-Control: no-store — the payload varies per viewer.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { categories, matches, tournaments } from "@oddzilla/db";
import type {
  CustomBoostedMarket,
  CustomBoostedOddsResponse,
  CustomBoostedSelection,
} from "@oddzilla/types";
import {
  loadBoostRulesForMatch,
  loadViewerRiskScore,
  passesRiskGate,
} from "../../lib/boosted-odds.js";

const paramsSchema = z.object({ matchId: z.coerce.bigint() });

const EMPTY = (): CustomBoostedOddsResponse => ({
  entries: [],
  selections: [],
  matchWide: null,
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

    // No market enumeration AT ALL. Live matches churn market rows
    // constantly — Oddin creates NEW ladder lines on odds updates and
    // suspends/reactivates the whole book between rounds — so any
    // per-market flattening of a match-wide rule is stale the moment
    // it's built (fresh lines rendered unboosted until the next poll;
    // a poll during the between-round suspension flashed EVERY boost
    // off). Instead the cascade-resolved match-wide rule ships as one
    // object the client applies to whatever markets it currently
    // renders; explicit market-scope rules ship per market (those ids
    // are stable — the rule pins the row).
    let matchRule: (typeof eligible)[number] | null = null;
    let competitorBest: (typeof eligible)[number] | null = null;
    let tournamentRule: (typeof eligible)[number] | null = null;
    let sportRule: (typeof eligible)[number] | null = null;
    const marketEntries: CustomBoostedMarket[] = [];
    const selections: CustomBoostedSelection[] = [];
    for (const r of eligible) {
      switch (r.scope) {
        case "market":
          marketEntries.push({
            ruleId: r.id,
            marketId: r.marketId!.toString(),
            boostPct: r.boostPct,
            endsAt: r.endsAt?.toISOString() ?? null,
          });
          break;
        case "outcome":
          selections.push({
            ruleId: r.id,
            marketId: r.marketId!.toString(),
            outcomeId: r.outcomeId!,
            boostPct: r.boostPct,
            endsAt: r.endsAt?.toISOString() ?? null,
          });
          break;
        case "match":
          matchRule = r;
          break;
        case "competitor":
          if (!competitorBest || r.boostPct > competitorBest.boostPct) {
            competitorBest = r;
          }
          break;
        case "tournament":
          tournamentRule = r;
          break;
        case "sport":
          sportRule = r;
          break;
      }
    }
    const wide = matchRule ?? competitorBest ?? tournamentRule ?? sportRule;

    // A selection boost takes over its market's pricing, so drop any
    // market-scope entry for the same market. The client applies the
    // same precedence to `matchWide` (which stays unflattened — see
    // above), so both sides agree without the server enumerating
    // markets.
    const selectionMarkets = new Set(selections.map((s) => s.marketId));

    return {
      entries: marketEntries.filter((e) => !selectionMarkets.has(e.marketId)),
      selections,
      matchWide: wide
        ? {
            ruleId: wide.id,
            boostPct: wide.boostPct,
            endsAt: wide.endsAt?.toISOString() ?? null,
          }
        : null,
      serverNow: new Date().toISOString(),
    } satisfies CustomBoostedOddsResponse;
  });
}
