// Custom Boosted Odds engine helpers (migration 0085).
//
// Rules live in boosted_odds_config — one row per (scope, ref) pinned
// to a sport / tournament / match / competitor / market / single
// selection (migrations 0087-0088). Boost math is the same Netwinstable
// key delta ZillaFlash uses; the boosted price is recomputed from live
// published_odds on every read, never stored. All three consumers route
// through the shared quoteMarketBoost so the match page's realtime
// compute, the banners endpoint, and placement can't drift apart.
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
  isQuotableOutcomeOdds,
  quoteMarketBoost,
  CUSTOM_BOOST_DEFAULT_RISK_SCORE,
  CUSTOM_BOOST_PLACEMENT_TOLERANCE,
  type BoostedOddsScope,
  type BoostQuoteCell,
  type BoostQuoteRule,
} from "@oddzilla/types";

export interface BoostRule {
  id: string;
  scope: BoostedOddsScope;
  sportId: number | null;
  tournamentId: number | null;
  matchId: bigint | null;
  competitorId: number | null;
  marketId: bigint | null;
  /** scope='outcome' only — the boosted cell within `marketId`. */
  outcomeId: string | null;
  boostPct: number;
  endsAt: Date | null;
  minRiskScore: number | null;
}

/** BoostRule -> the subset quoteMarketBoost needs. */
export function toQuoteRule(rule: BoostRule): BoostQuoteRule {
  return {
    ruleId: rule.id,
    boostPct: rule.boostPct,
    endsAt: rule.endsAt?.toISOString() ?? null,
  };
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
    outcomeId: r.outcomeId,
    boostPct: Number(r.boostPct),
    endsAt: r.endsAt,
    minRiskScore: r.minRiskScore !== null ? Number(r.minRiskScore) : null,
  };
}

/**
 * Every non-expired rule that could apply to any market of this match.
 * Market- and outcome-scope rules are matched via a subquery over the
 * match's markets so one round-trip covers all six tiers. The Min Risk
 * Score gate is applied by the caller (per viewer), not here.
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
            inArray(boostedOddsConfig.scope, ["market", "outcome"]),
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
 * Resolve which MARKET-WIDE rule prices a given market. Most specific
 * wins: market > match > competitor > tournament > sport. Two competitor
 * rules covering the same match (both teams boosted) resolve to the
 * higher boost_pct. Rules failing the caller-side RS gate must be
 * filtered out BEFORE calling this.
 *
 * Outcome-scope rules are NOT considered here — they price a single cell
 * and are resolved by selectionRulesForMarket. When a market has any,
 * they take over its pricing entirely and this result is ignored (see
 * quoteMarketBoost).
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
      case "outcome":
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

/**
 * Apply a market-wide rule and/or the market's selection rules to its
 * active outcome set. Returns null when nothing ends up boosted — the
 * book is already at/below fair (fair-book clamp), the market has fewer
 * than 2 priced outcomes on the market-wide path, or the move is
 * invisible at 2-decimal display precision.
 *
 * Thin wrapper over the shared quoteMarketBoost so the api, the match
 * page, and the banners endpoint can never drift apart on the math.
 */
export function quoteBoostedMarket(
  rule: BoostRule | null,
  outcomes: ReadonlyArray<{ outcomeId: string; publishedOdds: number }>,
  selections?: ReadonlyMap<string, BoostRule> | null,
): BoostQuoteCell[] | null {
  const selectionQuotes = selections
    ? new Map(
        Array.from(selections, ([outcomeId, r]) => [outcomeId, toQuoteRule(r)]),
      )
    : null;
  const cells = quoteMarketBoost({
    outcomes,
    marketWide: rule ? toQuoteRule(rule) : null,
    selections: selectionQuotes,
  });
  return cells.length > 0 ? cells : null;
}

/** Priced + active outcome set of one market, in stored order. */
export async function loadQuotableOutcomes(
  db: FastifyInstance["db"],
  marketId: bigint,
): Promise<Array<{ outcomeId: string; publishedOdds: number }>> {
  const rows = await db
    .select({
      outcomeId: marketOutcomes.outcomeId,
      publishedOdds: marketOutcomes.publishedOdds,
      active: marketOutcomes.active,
    })
    .from(marketOutcomes)
    .where(eq(marketOutcomes.marketId, marketId));
  return rows
    .filter((o) => o.active && o.publishedOdds !== null)
    .map((o) => ({
      outcomeId: o.outcomeId,
      publishedOdds: Number(o.publishedOdds),
    }))
    .filter((o) => isQuotableOutcomeOdds(o.publishedOdds));
}

/**
 * Which of these markets are priced by SELECTION boosts for this
 * viewer. Banner surfaces quote server-side against a market-wide rule,
 * so they need this to skip any market the match page and placement
 * would both price by its selection rules instead — otherwise the
 * banner advertises a price that 400s the moment it reaches the slip.
 */
export async function loadSelectionBoostedMarketIds(
  db: FastifyInstance["db"],
  marketIds: readonly bigint[],
  riskScore: number,
): Promise<Set<string>> {
  if (marketIds.length === 0) return new Set();
  const rows = await db
    .select({
      marketId: boostedOddsConfig.marketId,
      minRiskScore: boostedOddsConfig.minRiskScore,
    })
    .from(boostedOddsConfig)
    .where(
      and(
        eq(boostedOddsConfig.scope, "outcome"),
        inArray(boostedOddsConfig.marketId, [...marketIds]),
        or(isNull(boostedOddsConfig.endsAt), gt(boostedOddsConfig.endsAt, sql`now()`)),
      ),
    );
  const out = new Set<string>();
  for (const r of rows) {
    if (r.marketId === null) continue;
    if (r.minRiskScore !== null && riskScore < Number(r.minRiskScore)) continue;
    out.add(r.marketId.toString());
  }
  return out;
}

/**
 * Every non-expired outcome-scope rule on one market, RS-gated for the
 * viewer. Needed even when validating a market-wide leg: a market that
 * has selection rules is priced by them alone, so a coarser rule must
 * not validate against it.
 */
async function loadSelectionRules(
  db: FastifyInstance["db"],
  marketId: bigint,
  riskScore: number,
): Promise<Map<string, BoostRule>> {
  const rows = await db
    .select()
    .from(boostedOddsConfig)
    .where(
      and(
        eq(boostedOddsConfig.scope, "outcome"),
        eq(boostedOddsConfig.marketId, marketId),
        or(isNull(boostedOddsConfig.endsAt), gt(boostedOddsConfig.endsAt, sql`now()`)),
      ),
    );
  const out = new Map<string, BoostRule>();
  for (const row of rows) {
    const rule = rowToRule(row);
    if (rule.outcomeId === null) continue;
    if (!passesRiskGate(rule, riskScore)) continue;
    out.set(rule.outcomeId, rule);
  }
  return out;
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
    (rule.scope === "outcome" &&
      rule.marketId === market.id &&
      rule.outcomeId === args.outcomeId) ||
    (rule.scope === "market" && rule.marketId === market.id) ||
    (rule.scope === "match" && rule.matchId === market.matchId) ||
    (rule.scope === "competitor" &&
      rule.competitorId !== null &&
      (rule.competitorId === market.homeCompetitorId ||
        rule.competitorId === market.awayCompetitorId)) ||
    (rule.scope === "tournament" && rule.tournamentId === market.tournamentId) ||
    (rule.scope === "sport" && rule.sportId === market.sportId);
  if (!covers) return { ok: false, reason: "boosted_odds_not_applicable" };

  // Selection rules on this market are needed either way: on the
  // outcome path they set the joint fair-book scaling, and on the
  // market-wide path their mere existence means the coarser rule was
  // suppressed for the viewer (quoteMarketBoost's precedence), so it
  // must not price a leg here.
  const selections = await loadSelectionRules(
    app.db,
    marketIdBig,
    args.riskScore,
  );
  if (rule.scope !== "outcome" && selections.size > 0) {
    return { ok: false, reason: "boosted_odds_not_applicable" };
  }

  const priced = await loadQuotableOutcomes(app.db, marketIdBig);
  const quote = quoteBoostedMarket(
    rule.scope === "outcome" ? null : rule,
    priced,
    rule.scope === "outcome" ? selections : null,
  );
  if (!quote) return { ok: false, reason: "boosted_odds_not_applicable" };
  const snap = quote.find((q) => q.outcomeId === args.outcomeId);
  if (!snap) return { ok: false, reason: "boosted_odds_not_applicable" };
  // The cell must be priced by the rule the leg claims. On the outcome
  // path `selections` may carry several rules; a leg quoting rule A's
  // id against outcome B's price is a client bug, not a boost.
  if (snap.ruleId !== rule.id) {
    return { ok: false, reason: "boosted_odds_not_applicable" };
  }

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
