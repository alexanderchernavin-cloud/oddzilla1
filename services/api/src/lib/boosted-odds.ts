// Custom Boosted Odds engine helpers (migration 0085).
//
// Rules live in boosted_odds_config — one row per (scope, ref) pinned
// to a sport / tournament / match / competitor / market. Boost math is
// the same Netwinstable key delta ZillaFlash uses (boostMarketKey):
// the boosted price is recomputed from live published_odds on every
// read, never stored.
//
// Two consumers:
//   - GET /catalog/matches/:id/boosted-odds (modules/boosted-odds) —
//     resolves every boosted market on a match for the viewer.
//   - POST /bets pre-step (modules/bets/routes.ts) — re-validates the
//     leg's rule + recomputes the authoritative boosted price before
//     the placement debits stake.

import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  boostedOddsConfig,
  categories,
  marketOutcomes,
  markets,
  matches,
  tournaments,
  users,
} from "@oddzilla/db";
import {
  boostMarketKey,
  formatBoostedOdds,
  CUSTOM_BOOST_DEFAULT_RISK_SCORE,
  CUSTOM_BOOST_PLACEMENT_TOLERANCE,
  type BoostedOddsScope,
} from "@oddzilla/types";

export interface BoostRule {
  id: string;
  scope: BoostedOddsScope;
  sportId: number | null;
  tournamentId: number | null;
  matchId: bigint | null;
  competitorId: number | null;
  marketId: bigint | null;
  boostPct: number;
  endsAt: Date | null;
  minRiskScore: number | null;
}

export interface MatchBoostContext {
  matchId: bigint;
  tournamentId: number;
  sportId: number;
  homeCompetitorId: number | null;
  awayCompetitorId: number | null;
}

function rowToRule(
  r: typeof boostedOddsConfig.$inferSelect,
): BoostRule {
  return {
    id: r.id,
    scope: r.scope,
    sportId: r.sportId,
    tournamentId: r.tournamentId,
    matchId: r.matchId,
    competitorId: r.competitorId,
    marketId: r.marketId,
    boostPct: Number(r.boostPct),
    endsAt: r.endsAt,
    minRiskScore: r.minRiskScore !== null ? Number(r.minRiskScore) : null,
  };
}

/**
 * Every non-expired rule that could apply to any market of this match.
 * Market-scope rules are matched via a subquery over the match's
 * markets so one round-trip covers all five tiers. The Min Risk Score
 * gate is applied by the caller (per viewer), not here.
 */
export async function loadBoostRulesForMatch(
  db: FastifyInstance["db"],
  ctx: MatchBoostContext,
): Promise<BoostRule[]> {
  const competitorIds = [
    ...(ctx.homeCompetitorId !== null ? [ctx.homeCompetitorId] : []),
    ...(ctx.awayCompetitorId !== null ? [ctx.awayCompetitorId] : []),
  ];
  const rows = await db
    .select()
    .from(boostedOddsConfig)
    .where(
      and(
        or(isNull(boostedOddsConfig.endsAt), gt(boostedOddsConfig.endsAt, sql`now()`)),
        or(
          and(
            eq(boostedOddsConfig.scope, "sport"),
            eq(boostedOddsConfig.sportId, ctx.sportId),
          ),
          and(
            eq(boostedOddsConfig.scope, "tournament"),
            eq(boostedOddsConfig.tournamentId, ctx.tournamentId),
          ),
          and(
            eq(boostedOddsConfig.scope, "match"),
            eq(boostedOddsConfig.matchId, ctx.matchId),
          ),
          competitorIds.length > 0
            ? and(
                eq(boostedOddsConfig.scope, "competitor"),
                inArray(boostedOddsConfig.competitorId, competitorIds),
              )
            : sql`false`,
          and(
            eq(boostedOddsConfig.scope, "market"),
            inArray(
              boostedOddsConfig.marketId,
              db
                .select({ id: markets.id })
                .from(markets)
                .where(eq(markets.matchId, ctx.matchId)),
            ),
          ),
        ),
      ),
    );
  return rows.map(rowToRule);
}

/** True when the viewer's risk score clears the rule's gate. */
export function passesRiskGate(
  rule: BoostRule,
  riskScore: number,
): boolean {
  if (rule.minRiskScore === null) return true;
  return riskScore >= rule.minRiskScore;
}

/**
 * Resolve which rule prices a given market. Most specific wins:
 * market > match > competitor > tournament > sport. Two competitor
 * rules covering the same match (both teams boosted) resolve to the
 * higher boost_pct. Rules failing the caller-side RS gate must be
 * filtered out BEFORE calling this.
 */
export function resolveBoostForMarket(
  rules: readonly BoostRule[],
  marketId: bigint,
): BoostRule | null {
  let competitorBest: BoostRule | null = null;
  let matchRule: BoostRule | null = null;
  let tournamentRule: BoostRule | null = null;
  let sportRule: BoostRule | null = null;
  for (const r of rules) {
    switch (r.scope) {
      case "market":
        if (r.marketId === marketId) return r;
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
  return matchRule ?? competitorBest ?? tournamentRule ?? sportRule;
}

/**
 * Viewer risk score for the RS gate. Anonymous viewers get the default
 * (1.000 — same value a fresh signup carries), so a rule with
 * minRiskScore <= 1 shows to everyone and a higher threshold hides the
 * boost from logged-out browsing too.
 */
export async function loadViewerRiskScore(
  db: FastifyInstance["db"],
  userId: string | null | undefined,
): Promise<number> {
  if (!userId) return CUSTOM_BOOST_DEFAULT_RISK_SCORE;
  const [row] = await db
    .select({ riskScore: users.riskScore })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const n = row?.riskScore !== undefined ? Number(row.riskScore) : NaN;
  return Number.isFinite(n) ? n : CUSTOM_BOOST_DEFAULT_RISK_SCORE;
}

export interface BoostedMarketQuote {
  ruleId: string;
  boostPct: number;
  endsAt: Date | null;
  outcomes: Array<{
    outcomeId: string;
    originalOdds: string;
    boostedOdds: string;
  }>;
}

/**
 * Apply a rule to one market's active outcome set. Returns null when
 * the boost is a no-op (book already at/below fair — boostMarketKey's
 * clamp) or the market has fewer than 2 priced outcomes.
 */
export function quoteBoostedMarket(
  rule: BoostRule,
  outcomes: ReadonlyArray<{ outcomeId: string; publishedOdds: number }>,
): BoostedMarketQuote["outcomes"] | null {
  if (outcomes.length < 2) return null;
  const adjusted = boostMarketKey(
    outcomes.map((o) => o.publishedOdds),
    rule.boostPct,
  );
  if (adjusted.effectiveKeyDelta <= 0) return null;
  const rows = outcomes.map((o, i) => ({
    outcomeId: o.outcomeId,
    originalOdds: formatBoostedOdds(o.publishedOdds),
    boostedOdds: formatBoostedOdds(adjusted.adjustedOdds[i]!),
  }));
  // Drop when nothing visibly moved (fmtOdds floors to 2dp) — a
  // crossed-out "1.95 → 1.95" reads as a bug, not a promo.
  if (rows.every((r) => r.boostedOdds === r.originalOdds)) return null;
  return rows;
}

export type CustomBoostValidation =
  | { ok: true; authoritativeOdds: string; ruleId: string }
  | { ok: false; reason: string };

/**
 * Placement-time re-validation for a leg carrying boostedOddsRuleId.
 * Loads the rule + the market's live outcome set, checks the rule
 * still covers this market and the bettor clears the RS gate, then
 * recomputes the boosted price and compares against what the client
 * quoted (±CUSTOM_BOOST_PLACEMENT_TOLERANCE). On success the caller
 * overwrites the leg's odds with `authoritativeOdds`.
 */
export async function validateCustomBoostForBet(
  app: FastifyInstance,
  args: {
    ruleId: string;
    marketId: string;
    outcomeId: string;
    quotedOdds: string;
    riskScore: number;
  },
): Promise<CustomBoostValidation> {
  const [row] = await app.db
    .select()
    .from(boostedOddsConfig)
    .where(eq(boostedOddsConfig.id, args.ruleId))
    .limit(1);
  if (!row) return { ok: false, reason: "boosted_odds_unknown_rule" };
  const rule = rowToRule(row);
  if (rule.endsAt !== null && rule.endsAt.getTime() <= Date.now()) {
    return { ok: false, reason: "boosted_odds_rule_expired" };
  }
  if (!passesRiskGate(rule, args.riskScore)) {
    return { ok: false, reason: "boosted_odds_not_eligible" };
  }

  const marketIdBig = BigInt(args.marketId);
  const [market] = await app.db
    .select({
      id: markets.id,
      matchId: markets.matchId,
      status: markets.status,
      tournamentId: matches.tournamentId,
      sportId: categories.sportId,
      homeCompetitorId: matches.homeCompetitorId,
      awayCompetitorId: matches.awayCompetitorId,
    })
    .from(markets)
    .innerJoin(matches, eq(matches.id, markets.matchId))
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .innerJoin(categories, eq(categories.id, tournaments.categoryId))
    .where(eq(markets.id, marketIdBig))
    .limit(1);
  if (!market) return { ok: false, reason: "boosted_odds_not_applicable" };

  const covers =
    (rule.scope === "market" && rule.marketId === market.id) ||
    (rule.scope === "match" && rule.matchId === market.matchId) ||
    (rule.scope === "competitor" &&
      rule.competitorId !== null &&
      (rule.competitorId === market.homeCompetitorId ||
        rule.competitorId === market.awayCompetitorId)) ||
    (rule.scope === "tournament" && rule.tournamentId === market.tournamentId) ||
    (rule.scope === "sport" && rule.sportId === market.sportId);
  if (!covers) return { ok: false, reason: "boosted_odds_not_applicable" };

  const outcomeRows = await app.db
    .select({
      outcomeId: marketOutcomes.outcomeId,
      publishedOdds: marketOutcomes.publishedOdds,
      active: marketOutcomes.active,
    })
    .from(marketOutcomes)
    .where(eq(marketOutcomes.marketId, marketIdBig));
  const priced = outcomeRows
    .filter((o) => o.active && o.publishedOdds !== null)
    .map((o) => ({
      outcomeId: o.outcomeId,
      publishedOdds: Number(o.publishedOdds),
    }))
    // >= 1 in parity with the client compute: a favorite at exactly
    // 1.00 stays in the set (boostMarketKey leaves it unchanged) so a
    // live near-decided market doesn't lose its boost on every tick.
    .filter((o) => Number.isFinite(o.publishedOdds) && o.publishedOdds >= 1);
  const quote = quoteBoostedMarket(rule, priced);
  if (!quote) return { ok: false, reason: "boosted_odds_not_applicable" };
  const snap = quote.find((q) => q.outcomeId === args.outcomeId);
  if (!snap) return { ok: false, reason: "boosted_odds_not_applicable" };

  const quoted = Number.parseFloat(args.quotedOdds);
  const auth = Number.parseFloat(snap.boostedOdds);
  if (!Number.isFinite(quoted) || !Number.isFinite(auth)) {
    return { ok: false, reason: "boosted_odds_drift" };
  }
  if (Math.abs(quoted - auth) > CUSTOM_BOOST_PLACEMENT_TOLERANCE) {
    return { ok: false, reason: "boosted_odds_drift" };
  }
  return { ok: true, authoritativeOdds: snap.boostedOdds, ruleId: rule.id };
}
