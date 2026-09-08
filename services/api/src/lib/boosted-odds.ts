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

import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
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
  isTeamShapedMarket,
  type BoostQuoteCell,
  type BoostQuoteRule,
  type CompetitorBoostMarkets,
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
  startsAt: Date | null;
  endsAt: Date | null;
  minRiskScore: number | null;
  /** scope='competitor' only — 'all' | 'team_only' (migration 0093). */
  competitorMarkets: CompetitorBoostMarkets;
}

/**
 * True when this rule only boosts its team's own outcomes rather than
 * every market of the team's matches. Such a rule is priced like an
 * outcome-scope rule, so callers must route it through `selections`
 * (never `marketWide`) or the opponent's price moves too.
 */
export function isTeamOnlyRule(rule: BoostRule): boolean {
  return rule.scope === "competitor" && rule.competitorMarkets === "team_only";
}

/**
 * Which outcome id represents this rule's team on the given match, or
 * null when the rule isn't team-only / the team isn't in this match.
 * Team-shaped markets put the home competitor at outcome "1" and the
 * away one at "2" (see isTeamShapedMarket).
 */
export function teamOutcomeForRule(
  rule: BoostRule,
  ctx: Pick<MatchBoostContext, "homeCompetitorId" | "awayCompetitorId">,
): "1" | "2" | null {
  if (!isTeamOnlyRule(rule) || rule.competitorId === null) return null;
  if (ctx.homeCompetitorId === rule.competitorId) return "1";
  if (ctx.awayCompetitorId === rule.competitorId) return "2";
  return null;
}

/** BoostRule -> the subset quoteMarketBoost needs. */
export function toQuoteRule(rule: BoostRule): BoostQuoteRule {
  return {
    ruleId: rule.id,
    boostPct: rule.boostPct,
    endsAt: rule.endsAt?.toISOString() ?? null,
  };
}

/**
 * SQL predicate for "this rule is live right now" — inside its
 * scheduling window (migration 0092).
 *
 * Shared by every reader on purpose. A reader that checked only
 * `ends_at` would price, display, and PAY OUT a boost the operator
 * scheduled for a future date, so the two halves must never be written
 * out by hand at a call site again.
 */
export function boostWindowIsOpen() {
  return and(
    or(
      isNull(boostedOddsConfig.startsAt),
      lte(boostedOddsConfig.startsAt, sql`now()`),
    ),
    or(isNull(boostedOddsConfig.endsAt), gt(boostedOddsConfig.endsAt, sql`now()`)),
  );
}

/** In-memory twin of boostWindowIsOpen, for an already-loaded rule. */
export function ruleWindowIsOpen(
  rule: Pick<BoostRule, "startsAt" | "endsAt">,
  nowMs = Date.now(),
): boolean {
  if (rule.startsAt !== null && rule.startsAt.getTime() > nowMs) return false;
  if (rule.endsAt !== null && rule.endsAt.getTime() <= nowMs) return false;
  return true;
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
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    minRiskScore: r.minRiskScore !== null ? Number(r.minRiskScore) : null,
    competitorMarkets:
      r.competitorMarkets === "team_only" ? "team_only" : "all",
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
        boostWindowIsOpen(),
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

/**
 * Batched sibling of loadBoostRulesForMatch, for the storefront LIST
 * endpoints (sport page, lobby, /live, /upcoming) which price one
 * market per match across up to a few hundred matches. One round-trip
 * covers every tier for the whole page; resolution then happens in
 * memory per match.
 *
 * `marketIds` scopes the market- and outcome-tier lookup to the markets
 * the caller will actually price (the match-winner row, the Top market
 * cell) rather than every market on every match — a live CS2 match
 * carries hundreds of ladder rows we'd never render on a list card.
 *
 * The RS gate is applied here (the caller passes the viewer's score), so
 * every rule the returned resolver hands back is already deliverable.
 */
export interface BatchedMatchBoosts {
  /** True when nothing in the batch is boosted — lets callers skip work. */
  readonly empty: boolean;
  /**
   * Everything quoteMarketBoost needs for one market, resolved together.
   *
   * `providerMarketId` AND `outcomeIds` are both REQUIRED because a
   * `team_only` competitor rule (migration 0093) may only touch
   * team-shaped markets, and must be applied as a SELECTION on that
   * team's own outcome — never market-wide, or the opponent's price moves
   * too. The ids are part of that test rather than a convenience: on the
   * Fonbet side they are the only thing separating a winner table from
   * its own sub-event copies, which share a provider_market_id (see
   * isTeamShapedMarket). Returning the two halves from one call makes the
   * market-wide mistake impossible at a call site; an earlier split
   * `marketWide()` / `selections()` pair let a caller take the competitor
   * rule as market-wide by accident.
   */
  resolve(
    ctx: MatchBoostContext,
    marketId: bigint,
    providerMarketId: number,
    outcomeIds: readonly string[],
  ): {
    marketWide: BoostRule | null;
    selections: Map<string, BoostRule> | null;
  };
}

export async function loadBoostRulesForMatches(
  db: FastifyInstance["db"],
  contexts: readonly MatchBoostContext[],
  marketIds: readonly bigint[],
  riskScore: number,
): Promise<BatchedMatchBoosts> {
  const emptyResult: BatchedMatchBoosts = {
    empty: true,
    resolve: () => ({ marketWide: null, selections: null }),
  };
  if (contexts.length === 0) return emptyResult;

  const sportIds = [...new Set(contexts.map((c) => c.sportId))];
  const tournamentIds = [...new Set(contexts.map((c) => c.tournamentId))];
  const matchIds = [...new Set(contexts.map((c) => c.matchId))];
  const competitorIds = [
    ...new Set(
      contexts.flatMap((c) =>
        [c.homeCompetitorId, c.awayCompetitorId].filter(
          (v): v is number => v !== null,
        ),
      ),
    ),
  ];
  const marketIdSet = [...new Set(marketIds)];

  const rows = await db
    .select()
    .from(boostedOddsConfig)
    .where(
      and(
        boostWindowIsOpen(),
        or(
          and(
            eq(boostedOddsConfig.scope, "sport"),
            inArray(boostedOddsConfig.sportId, sportIds),
          ),
          and(
            eq(boostedOddsConfig.scope, "tournament"),
            inArray(boostedOddsConfig.tournamentId, tournamentIds),
          ),
          and(
            eq(boostedOddsConfig.scope, "match"),
            inArray(boostedOddsConfig.matchId, matchIds),
          ),
          competitorIds.length > 0
            ? and(
                eq(boostedOddsConfig.scope, "competitor"),
                inArray(boostedOddsConfig.competitorId, competitorIds),
              )
            : sql`false`,
          marketIdSet.length > 0
            ? and(
                inArray(boostedOddsConfig.scope, ["market", "outcome"]),
                inArray(boostedOddsConfig.marketId, marketIdSet),
              )
            : sql`false`,
        ),
      ),
    );

  const rules = rows.map(rowToRule).filter((r) => passesRiskGate(r, riskScore));
  if (rules.length === 0) return emptyResult;

  const bySport = new Map<number, BoostRule>();
  const byTournament = new Map<number, BoostRule>();
  const byMatch = new Map<string, BoostRule>();
  const byCompetitor = new Map<number, BoostRule>();
  const byMarket = new Map<string, BoostRule>();
  const selectionsByMarket = new Map<string, Map<string, BoostRule>>();
  for (const r of rules) {
    switch (r.scope) {
      case "sport":
        if (r.sportId !== null) bySport.set(r.sportId, r);
        break;
      case "tournament":
        if (r.tournamentId !== null) byTournament.set(r.tournamentId, r);
        break;
      case "match":
        if (r.matchId !== null) byMatch.set(r.matchId.toString(), r);
        break;
      case "competitor":
        if (r.competitorId !== null) byCompetitor.set(r.competitorId, r);
        break;
      case "market":
        if (r.marketId !== null) byMarket.set(r.marketId.toString(), r);
        break;
      case "outcome": {
        if (r.marketId === null || r.outcomeId === null) break;
        const key = r.marketId.toString();
        const m = selectionsByMarket.get(key) ?? new Map<string, BoostRule>();
        m.set(r.outcomeId, r);
        selectionsByMarket.set(key, m);
        break;
      }
    }
  }

  return {
    empty: false,
    resolve(ctx, marketId, providerMarketId, outcomeIds) {
      // Explicit outcome-scope rules first — they always win their cell.
      const explicit = selectionsByMarket.get(marketId.toString()) ?? null;
      const selections = explicit ? new Map(explicit) : null;

      // team_only competitor rules become selections on their own team's
      // outcome, and only where the market is team-shaped. Both teams
      // can be boosted this way at once — each gets its own cell, which
      // the market-wide tie-break below couldn't express.
      let teamOnly: Map<string, BoostRule> | null = null;
      if (isTeamShapedMarket(providerMarketId, outcomeIds)) {
        for (const id of [ctx.homeCompetitorId, ctx.awayCompetitorId]) {
          if (id === null) continue;
          const r = byCompetitor.get(id);
          if (!r || !isTeamOnlyRule(r)) continue;
          const outcomeId = teamOutcomeForRule(r, ctx);
          if (!outcomeId) continue;
          // An explicit outcome rule on that same cell outranks it.
          if (selections?.has(outcomeId)) continue;
          teamOnly ??= new Map();
          teamOnly.set(outcomeId, r);
        }
      }

      const mergedSelections =
        selections || teamOnly
          ? new Map([...(selections ?? []), ...(teamOnly ?? [])])
          : null;

      // Market-wide resolution, most specific first. team_only competitor
      // rules are skipped here — they were handled above and must never
      // price a whole market.
      const marketWide = ((): BoostRule | null => {
        const market = byMarket.get(marketId.toString());
        if (market) return market;
        const match = byMatch.get(ctx.matchId.toString());
        if (match) return match;
        // Both teams boosted -> the higher pct wins, same tie-break
        // resolveBoostForMarket uses.
        let competitorBest: BoostRule | null = null;
        for (const id of [ctx.homeCompetitorId, ctx.awayCompetitorId]) {
          if (id === null) continue;
          const r = byCompetitor.get(id);
          if (!r || isTeamOnlyRule(r)) continue;
          if (!competitorBest || r.boostPct > competitorBest.boostPct) {
            competitorBest = r;
          }
        }
        if (competitorBest) return competitorBest;
        return (
          byTournament.get(ctx.tournamentId) ?? bySport.get(ctx.sportId) ?? null
        );
      })();

      return { marketWide, selections: mergedSelections };
    },
  };
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
        boostWindowIsOpen(),
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
        boostWindowIsOpen(),
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
  // Outside its scheduling window: expired, or scheduled for later and
  // not live yet (migration 0092). Either way it must not price a bet.
  if (!ruleWindowIsOpen(rule)) {
    return {
      ok: false,
      reason:
        rule.startsAt !== null && rule.startsAt.getTime() > Date.now()
          ? "boosted_odds_not_started"
          : "boosted_odds_rule_expired",
    };
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
      // Needed to decide whether a team_only competitor rule may touch
      // this market at all (migration 0093).
      providerMarketId: markets.providerMarketId,
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

  // Loaded before the team_only gate below, which needs this market's
  // outcome IDS: on the Fonbet side they are the only thing that
  // separates a winner table from its own sub-event copies, which share a
  // provider_market_id (see isTeamShapedMarket). The pricing path a few
  // lines down wants the same rows, so this is a hoist, not a new query.
  const priced = await loadQuotableOutcomes(app.db, marketIdBig);

  // A team_only competitor rule prices ONE cell — this team's own
  // outcome, and only in a team-shaped market (migration 0093). Anything
  // else it might have covered under 'all' mode is not boosted, so a leg
  // claiming it there must be refused rather than priced.
  const teamOnlyOutcomeId = teamOutcomeForRule(rule, market);
  if (isTeamOnlyRule(rule)) {
    if (
      !isTeamShapedMarket(
        market.providerMarketId,
        priced.map((o) => o.outcomeId),
      ) ||
      teamOnlyOutcomeId === null ||
      teamOnlyOutcomeId !== args.outcomeId
    ) {
      return { ok: false, reason: "boosted_odds_not_applicable" };
    }
  }

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
  const pricedAsSelection = rule.scope === "outcome" || isTeamOnlyRule(rule);
  if (!pricedAsSelection && selections.size > 0) {
    return { ok: false, reason: "boosted_odds_not_applicable" };
  }
  // An explicit outcome rule on the same cell outranks a team_only one
  // (the resolver applies that precedence), so the leg should be
  // claiming that rule's id instead.
  if (isTeamOnlyRule(rule) && selections.has(args.outcomeId)) {
    return { ok: false, reason: "boosted_odds_not_applicable" };
  }

  // team_only is quoted through the selection path with a synthesized
  // single-cell map, so the delta comes out of that outcome's own
  // probability and the opponent's price is untouched — byte-identical
  // to what the client and the list cards compute.
  const effectiveSelections = pricedAsSelection
    ? rule.scope === "outcome"
      ? selections
      : new Map([[teamOnlyOutcomeId!, rule]])
    : null;
  const quote = quoteBoostedMarket(
    pricedAsSelection ? null : rule,
    priced,
    effectiveSelections,
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
