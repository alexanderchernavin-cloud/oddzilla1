// Bet placement business logic. Kept separate from routes for unit
// testability and because the placement transaction is load-bearing.
//
// Placement is one Postgres transaction:
//   1. SELECT FOR UPDATE users + wallet (locks for this user only)
//   2. For each selection: SELECT market + market_outcome; reject if
//      market inactive OR outcome inactive OR current odds drift beyond
//      tolerance from user-submitted odds.
//   3. INSERT tickets — ON CONFLICT (idempotency_key) DO NOTHING RETURNING;
//      if nothing returned, it's a replay — return the existing ticket.
//   4. INSERT ticket_selections rows.
//   5. UPDATE wallets SET locked_micro += stake.
//   6. INSERT wallet_ledger (type='bet_stake', ref_type='ticket', ref_id=ticket.id, delta=-stake).
//   7. If bet_delay_seconds > 0: status='pending_delay', not_before_ts=now()+delay,
//      pg_notify('bet_delay', ticket.id::text).
//      Else status='accepted', accepted_at=now().
//   8. Commit.
//
// The unique partial index on wallet_ledger makes the ledger write
// idempotent if this whole transaction is re-executed with the same ticket id.

import { Redis } from "ioredis";
import { eq, and, inArray, or, sql } from "drizzle-orm";
import type { DbClient } from "@oddzilla/db";
import {
  users,
  wallets,
  walletLedger,
  markets,
  marketDescriptions,
  marketOutcomes,
  matches,
  tickets,
  ticketSelections,
  sports,
  categories,
  tournaments,
  betProductConfig,
  combiBoostConfig,
  riskzillaLiveDelayConfig,
} from "@oddzilla/db";
import {
  DEFAULT_CURRENCY,
  DEFAULT_ODDS_DRIFT_TOLERANCE,
  computeCombiBoost,
  isCurrency,
  multiplyMicroByOdds,
  parseProbability,
  priceTiple,
  priceTippot,
  type BetBuilderMeta,
  type BetMeta,
  type BetType,
  type ComboMeta,
  type Currency,
  type PlaceBetRequest,
  type TicketSummary,
  type TippotMeta,
  type TipleMeta,
} from "@oddzilla/types";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
} from "../../lib/errors.js";
import {
  getSharedObbClient,
  ObbError,
} from "../../lib/obb-client.js";
import { substituteTemplate } from "../../lib/market-naming.js";
import {
  RiskzillaEngine,
  type RiskzillaIntent,
  type RiskzillaIntentLeg,
  type RiskzillaRejected,
  type MatchContext as RiskzillaMatchContext,
} from "../../lib/riskzilla/engine.js";
import {
  loadBettorAdjustmentCascade,
  resolveBettorAdjustmentBp,
  applyBettorAdjustment,
} from "../../lib/bettor-odds-adjustment.js";
import {
  loadPromoVisibilityCascades,
  resolveVisible,
} from "../../lib/bettor-promo-visibility.js";

// Internal sentinel: thrown from inside the placement tx when
// RiskZilla rejects the bet. The tx rolls back on throw; we catch in
// place(), record the rejection event_log row outside the
// rolled-back tx, and surface a typed BadRequestError to the client.
class RiskzillaRejectError extends Error {
  constructor(
    readonly result: RiskzillaRejected,
    readonly intent: RiskzillaIntent,
    readonly matchContext: RiskzillaMatchContext | null,
  ) {
    super(result.reason);
    this.name = "RiskzillaRejectError";
  }
}

// Shared singleton with the betbuilder routes (one gRPC channel
// across the api process). Null when env is missing — placement of
// betType="betbuilder" is then rejected upfront rather than calling
// Oddin. Oddin's own SessionInfo RPC is the source of truth for
// "are these selections + odds still valid?", so no extra per-leg
// drift check is needed for BetBuilder placements.
const obbBetsClient = getSharedObbClient();

const USER_CHANNEL_PREFIX = "user:";

type TxHandle = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// Shared selection-row query used by both the list (many tickets) and
// detail (single ticket) paths. The leftJoins keep rows when an
// upstream market/match was hard-deleted; summaryFromRows treats the
// nulls as "metadata unavailable".
function selectSelectionRows(
  db: DbClient | TxHandle,
  where: ReturnType<typeof inArray> | ReturnType<typeof eq>,
) {
  return db
    .select({
      sel: ticketSelections,
      providerMarketId: markets.providerMarketId,
      specifiersJson: markets.specifiersJson,
      marketStatus: markets.status,
      matchId: matches.id,
      homeTeam: matches.homeTeam,
      awayTeam: matches.awayTeam,
      matchStatus: matches.status,
      sportSlug: sports.slug,
      currentOdds: marketOutcomes.publishedOdds,
      outcomeActive: marketOutcomes.active,
      outcomeName: marketOutcomes.name,
    })
    .from(ticketSelections)
    .leftJoin(markets, eq(markets.id, ticketSelections.marketId))
    .leftJoin(matches, eq(matches.id, markets.matchId))
    .leftJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .leftJoin(categories, eq(categories.id, tournaments.categoryId))
    .leftJoin(sports, eq(sports.id, categories.sportId))
    .leftJoin(
      marketOutcomes,
      and(
        eq(marketOutcomes.marketId, ticketSelections.marketId),
        eq(marketOutcomes.outcomeId, ticketSelections.outcomeId),
      ),
    )
    .where(where);
}

// Batched lookup of market_description templates for the providerMarketIds
// touched by a set of selection rows. Returns a map keyed by
// `${providerMarketId}:${variant}` so the resolver can locale-prefer the
// variant-specific row and fall back to the empty-variant template.
//
// Defaults to language='en' — bet routes don't carry a locale today, and
// the catalog page already does the locale-prefer dance for /catalog/*.
// The fallback "Market #N" is rendered client-side when the lookup misses
// (rare — only happens for markets whose description Oddin hasn't shipped).
async function loadMarketDescriptionMap(
  db: DbClient | TxHandle,
  rows: Array<{ providerMarketId: number | null }>,
): Promise<Map<string, string>> {
  const ids = new Set<number>();
  for (const r of rows) {
    if (r.providerMarketId !== null) ids.add(r.providerMarketId);
  }
  if (ids.size === 0) return new Map();
  const descRows = await db
    .select({
      providerMarketId: marketDescriptions.providerMarketId,
      variant: marketDescriptions.variant,
      nameTemplate: marketDescriptions.nameTemplate,
    })
    .from(marketDescriptions)
    .where(
      and(
        inArray(marketDescriptions.providerMarketId, Array.from(ids)),
        eq(marketDescriptions.language, "en"),
      ),
    );
  const map = new Map<string, string>();
  for (const d of descRows) {
    map.set(`${d.providerMarketId}:${d.variant ?? ""}`, d.nameTemplate);
  }
  return map;
}

interface PlaceContext {
  userId: string;
  ip: string | null;
  userAgent: string | null;
  // Set by routes.ts when any leg came from a LIVE ZillaFlash offer
  // (boosted odds + countdown). The service shaves 2 s off the
  // effective live-bet acceptance delay for the entire ticket — the
  // boost was offered as a deliberate operator perk, so we don't want
  // the worker to also hold the placement at the full per-match
  // delay. Prematch ZillaFlash legs don't trigger this — pure-prematch
  // placements already get zero delay.
  zillaFlashLiveBoost?: boolean;
}

export class BetsService {
  private readonly riskzilla: RiskzillaEngine;

  constructor(
    private readonly db: DbClient,
    private readonly redis: Redis,
  ) {
    this.riskzilla = new RiskzillaEngine(db);
  }

  /**
   * Place a bet. Returns the resulting ticket summary. Safe to call with
   * the same `idempotencyKey` multiple times — subsequent calls return
   * the original ticket without creating duplicates or re-locking stake.
   */
  async place(req: PlaceBetRequest, ctx: PlaceContext): Promise<TicketSummary> {
    if (!req.selections.length) {
      throw new BadRequestError("no_selections", "no_selections");
    }
    // Resolve effective bet type. Default behavior preserved: 1 leg → single,
    // ≥ 2 → combo. tiple/tippot must be explicit (the math + payout
    // contract is materially different and we don't want to silently
    // upgrade users into a different product). Same goes for
    // "betbuilder" — it requires the betBuilder block.
    const betType: BetType =
      req.betType ?? (req.selections.length > 1 ? "combo" : "single");
    const isMultiLeg = req.selections.length > 1;
    const isProductBet = betType === "tiple" || betType === "tippot";
    const isBetBuilder = betType === "betbuilder";
    if (betType === "single" && req.selections.length !== 1) {
      throw new BadRequestError("single_requires_one_leg", "single_requires_one_leg");
    }
    if ((betType === "combo" || isProductBet || isBetBuilder) && !isMultiLeg) {
      throw new BadRequestError("multi_leg_required", "multi_leg_required");
    }
    if (betType === "system") {
      // Reserved enum value; not yet implemented in any layer.
      throw new BadRequestError("bet_type_unsupported", "bet_type_unsupported");
    }
    if (isBetBuilder) {
      if (!obbBetsClient) {
        throw new ServiceUnavailableError("betbuilder_disabled", "betbuilder_disabled");
      }
      if (!req.betBuilder) {
        throw new BadRequestError("betbuilder_block_required", "betbuilder_block_required");
      }
      // Selection count must match what was sent to OBB at quote time —
      // otherwise the round-trip session is meaningless.
      if (req.betBuilder.selectionIds.length !== req.selections.length) {
        throw new BadRequestError(
          "betbuilder_selection_mismatch",
          "betbuilder_selection_mismatch",
        );
      }
    }
    if (isMultiLeg) {
      // Same-match combos / tiples / tippots are a related-contingency
      // (the outcomes aren't independent) — standard bookmaker rule is to
      // block them. For probability-driven products this also breaks the
      // independence assumption baked into the math.
      //
      // BetBuilder is the inverse — Oddin's OBB engine specifically prices
      // same-match combinations (one selection per market still applies,
      // but the duplicate-market guard below catches that anyway).
      const seenMarkets = new Set<string>();
      for (const s of req.selections) {
        if (seenMarkets.has(s.marketId)) {
          throw new BadRequestError("duplicate_market", "duplicate_market");
        }
        seenMarkets.add(s.marketId);
      }
    }
    const stake = parseBigIntStrict(req.stakeMicro, "stakeMicro");
    if (stake <= 0n) {
      throw new BadRequestError("stake_must_be_positive", "stake_must_be_positive");
    }
    const currency: Currency = req.currency && isCurrency(req.currency)
      ? req.currency
      : DEFAULT_CURRENCY;
    const tolerance = DEFAULT_ODDS_DRIFT_TOLERANCE;

    let placed: TicketSummary;
    try {
      placed = await this.db.transaction(async (tx) => {
      // ── Idempotency short-circuit ────────────────────────────────────
      const existing = await tx
        .select()
        .from(tickets)
        .where(eq(tickets.idempotencyKey, req.idempotencyKey))
        .limit(1);
      if (existing.length > 0) {
        const t = existing[0]!;
        if (t.userId !== ctx.userId) {
          // Another user used the same key — treat as fresh client
          // generating a collision. Refuse to leak the first ticket.
          throw new ConflictError("idempotency_key_collision", "idempotency_key_collision");
        }
        return this.hydrateSummary(tx, t.id);
      }

      // ── Lock user + wallet row ───────────────────────────────────────
      const userRows = await tx
        .select({
          id: users.id,
          status: users.status,
          globalLimitMicro: users.globalLimitMicro,
          betDelaySeconds: users.betDelaySeconds,
          riskScore: users.riskScore,
        })
        .from(users)
        .where(eq(users.id, ctx.userId))
        .for("update")
        .limit(1);
      if (userRows.length === 0) throw new UnauthorizedError();
      const user = userRows[0]!;
      if (user.status !== "active") {
        throw new ForbiddenError("account_not_active", "account_not_active");
      }

      const walletRows = await tx
        .select()
        .from(wallets)
        .where(and(eq(wallets.userId, ctx.userId), eq(wallets.currency, currency)))
        .for("update")
        .limit(1);
      if (walletRows.length === 0) {
        throw new NotFoundError("wallet_not_found", "wallet_not_found");
      }
      const wallet = walletRows[0]!;
      const available = wallet.balanceMicro - wallet.lockedMicro;
      if (stake > available) {
        throw new BadRequestError("insufficient_balance", "insufficient_balance");
      }
      if (user.globalLimitMicro > 0n && stake > user.globalLimitMicro) {
        throw new BadRequestError("exceeds_global_limit", "exceeds_global_limit");
      }

      // ── Validate selections + fetch display metadata ─────────────────
      const marketIds = req.selections.map((s) => BigInt(s.marketId));
      const rows = await tx
        .select({
          marketId: markets.id,
          providerMarketId: markets.providerMarketId,
          marketStatus: markets.status,
          specifiersJson: markets.specifiersJson,
          matchId: matches.id,
          homeTeam: matches.homeTeam,
          awayTeam: matches.awayTeam,
          matchStatus: matches.status,
          sportSlug: sports.slug,
          // RiskZilla needs sport_id, tournament_id, and the
          // tournament's risk_tier to look up the right per-tier
          // settings row + write the decision-event_log row.
          sportId: sports.id,
          tournamentId: tournaments.id,
          tournamentRiskTier: tournaments.riskTier,
        })
        .from(markets)
        .innerJoin(matches, eq(matches.id, markets.matchId))
        .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
        .innerJoin(categories, eq(categories.id, tournaments.categoryId))
        .innerJoin(sports, eq(sports.id, categories.sportId))
        .where(inArray(markets.id, marketIds));
      const marketByID = new Map(rows.map((r) => [r.marketId.toString(), r]));

      // Fetch outcomes in one go.
      const outcomeRows = await tx
        .select()
        .from(marketOutcomes)
        .where(inArray(marketOutcomes.marketId, marketIds));
      const outcomeByKey = new Map(
        outcomeRows.map((o) => [`${o.marketId.toString()}:${o.outcomeId}`, o]),
      );

      // ── Per-product gating: load bet_product_config for tiple/tippot ─
      // Done inside the tx so admin updates take effect on the next bet
      // without cache invalidation. The table has at most 2 rows.
      let productCfg:
        | {
            marginBp: number;
            marginBpPerLeg: number;
            minLegs: number;
            maxLegs: number;
            enabled: boolean;
          }
        | null = null;
      if (isProductBet) {
        const [cfg] = await tx
          .select()
          .from(betProductConfig)
          .where(eq(betProductConfig.productName, betType))
          .limit(1);
        if (!cfg) {
          throw new BadRequestError("bet_product_unconfigured", "bet_product_unconfigured");
        }
        if (!cfg.enabled) {
          throw new BadRequestError("bet_product_disabled", "bet_product_disabled");
        }
        productCfg = {
          marginBp: cfg.marginBp,
          marginBpPerLeg: cfg.marginBpPerLeg,
          minLegs: cfg.minLegs,
          maxLegs: cfg.maxLegs,
          enabled: cfg.enabled,
        };
        if (req.selections.length < cfg.minLegs) {
          throw new BadRequestError("too_few_legs", "too_few_legs");
        }
        if (req.selections.length > cfg.maxLegs) {
          throw new BadRequestError("too_many_legs", "too_many_legs");
        }
      } else if (req.selections.length > 20) {
        // Combo cap (existing behavior, unchanged).
        throw new BadRequestError("too_many_legs", "too_many_legs");
      }

      // ── Per-bettor odds adjustment ───────────────────────────────────
      // Loaded once for the placement; the cascade resolves per leg using
      // (matchId, tournamentId, sportId) — same shape the catalog
      // endpoints used to render the slip's captured price. Adjustment
      // is meaningless for tiple / tippot (probability-based pricing)
      // and BetBuilder (OBB session combined), so we apply it only to
      // singles + traditional combos.
      const bettorCascade =
        !isProductBet && !isBetBuilder
          ? await loadBettorAdjustmentCascade(tx, ctx.userId)
          : null;

      let productOdds = 1;
      const seenMatchIds = new Set<string>();
      let betBuilderMatchId: string | null = null;
      // Probabilities aligned 1:1 with req.selections — only used for
      // tiple/tippot pricing. Sourced from market_outcomes (server-trusted).
      // The persisted leg.probabilityAtPlacement comes from outcome.probability
      // directly at the insert site, so we don't need to thread strings here.
      const probabilities: number[] = [];
      for (const sel of req.selections) {
        const market = marketByID.get(sel.marketId);
        if (!market) {
          throw new BadRequestError("market_not_found", "market_not_found");
        }
        if (market.marketStatus !== 1) {
          throw new BadRequestError("market_not_active", "market_not_active");
        }
        if (market.matchStatus !== "not_started" && market.matchStatus !== "live") {
          throw new BadRequestError("match_not_open", "match_not_open");
        }
        if (isMultiLeg && !isBetBuilder) {
          // Cross-match guard for traditional combos / tiples / tippots.
          // BetBuilder inverts the rule: every leg must come from the
          // same match (Oddin's OBB engine prices same-match-only).
          const matchKey = market.matchId.toString();
          if (seenMatchIds.has(matchKey)) {
            throw new BadRequestError("combo_same_match", "combo_same_match");
          }
          seenMatchIds.add(matchKey);
        }
        if (isBetBuilder) {
          const matchKey = market.matchId.toString();
          if (betBuilderMatchId === null) {
            betBuilderMatchId = matchKey;
          } else if (betBuilderMatchId !== matchKey) {
            throw new BadRequestError("betbuilder_cross_match", "betbuilder_cross_match");
          }
        }
        const outcome = outcomeByKey.get(`${sel.marketId}:${sel.outcomeId}`);
        if (!outcome) {
          throw new BadRequestError("outcome_not_found", "outcome_not_found");
        }
        if (!outcome.active) {
          throw new BadRequestError("outcome_not_active", "outcome_not_active");
        }
        if (!outcome.publishedOdds) {
          throw new BadRequestError("outcome_no_price", "outcome_no_price");
        }
        const currentOdds = Number(outcome.publishedOdds);
        const submittedOdds = Number(sel.odds);
        if (!Number.isFinite(currentOdds) || !Number.isFinite(submittedOdds)) {
          throw new BadRequestError("odds_parse_error", "odds_parse_error");
        }
        // Distinct rejection when the published price is non-positive —
        // that's a feed-pipeline bug (NUMERIC(10,4) shouldn't carry 0
        // or negatives, but defense in depth). Without this guard a
        // zero price falls through to the drift calc, the
        // `Math.abs(0 - x) / x = 1` ratio always exceeds tolerance,
        // and the user sees `odds_drift_exceeded` — misleading. Sec M6.
        if (currentOdds <= 0 || submittedOdds <= 0) {
          throw new BadRequestError("outcome_no_price", "outcome_no_price");
        }
        if (!isBetBuilder) {
          // BetBuilder skips per-leg drift: the agreed odds is the OBB
          // session combined odds. Per-leg movements may not reflect a
          // session-odds change because OBB's pricing model is
          // non-multiplicative (Oddin docs §1.1). Server re-validates
          // the whole session via SessionInfo below.
          //
          // For singles + traditional combos the drift is computed
          // against the bettor's *adjusted* current odds — the same
          // shape the slip captured at click time. Without this the
          // catalog's adjusted display and the server's drift gate
          // disagree, and every adjusted bettor sees odds_drift_exceeded
          // on placement.
          let driftReference = currentOdds;
          if (bettorCascade && !bettorCascade.empty) {
            const bp = resolveBettorAdjustmentBp(bettorCascade, {
              matchId: market.matchId,
              tournamentId: market.tournamentId,
              sportId: market.sportId,
            });
            const adj = applyBettorAdjustment(
              outcome.publishedOdds,
              outcome.probability,
              bp,
            );
            const parsed = adj != null ? Number(adj) : NaN;
            if (Number.isFinite(parsed) && parsed > 0) driftReference = parsed;
          }
          const drift = Math.abs(driftReference - submittedOdds) / submittedOdds;
          if (drift > tolerance) {
            throw new BadRequestError("odds_drift_exceeded", "odds_drift_exceeded");
          }
        }
        productOdds *= submittedOdds;

        // Probability: required for tiple/tippot, freezes on the leg row
        // either way (audit trail; settlement uses it for re-pricing on
        // void). priceTiple/priceTippot enforce p ∈ (0, 1) — exact 0/1
        // would degenerate the math.
        if (isProductBet) {
          if (!outcome.probability) {
            throw new BadRequestError("outcome_no_probability", "outcome_no_probability");
          }
          let p: number;
          try {
            p = parseProbability(outcome.probability);
          } catch {
            throw new BadRequestError("outcome_probability_invalid", "outcome_probability_invalid");
          }
          if (!(p > 0 && p < 1)) {
            throw new BadRequestError("outcome_probability_extreme", "outcome_probability_extreme");
          }
          probabilities.push(p);
        }
      }

      // ── Compute payout based on product ──────────────────────────────
      // Effective margin compounds the per-leg term over N multiplicatively
      // — same shape a combo's overround takes when each leg's margined
      // odds are multiplied together. Specifically:
      //
      //   1 + effective = (1 + base) × (1 + per_leg)^N
      //
      // For tiple (per_leg=0) the formula degenerates to flat `base`. For
      // tippot (default base=0, per_leg=500) at N=5 the effective overround
      // is 1.05^5 − 1 ≈ 27.6%. Rounded to integer basis points; the sub-bp
      // loss is well below quote precision (odds quote at 2 decimals).
      const effectiveMarginBp = productCfg
        ? Math.round(
            ((1 + productCfg.marginBp / 10000) *
              Math.pow(
                1 + productCfg.marginBpPerLeg / 10000,
                req.selections.length,
              ) -
              1) *
              10000,
          )
        : 0;
      let potentialPayoutMicro: bigint;
      let betMeta: BetMeta | null = null;
      if (betType === "tiple") {
        const quote = priceTiple(probabilities, effectiveMarginBp);
        if (Number(quote.offeredOdds) < 1.01) {
          // Refuse offered < 1.01 — bettor would lose money on a winning
          // ticket. Mirrors the floor odds-publisher applies elsewhere.
          throw new BadRequestError("tiple_odds_too_low", "tiple_odds_too_low");
        }
        potentialPayoutMicro = multiplyMicroByOdds(stake, quote.offeredOdds);
        const meta: TipleMeta = {
          product: "tiple",
          n: quote.n,
          marginBp: quote.marginBp,
          fairProbability: quote.fairProbability.toFixed(6),
        };
        betMeta = meta;
      } else if (betType === "tippot") {
        const quote = priceTippot(probabilities, effectiveMarginBp);
        // Top tier (all legs win) sets the displayed potential payout —
        // matches what users intuitively expect to see in the slip.
        const topMultiplier = quote.tiers[quote.tiers.length - 1]!.multiplier;
        potentialPayoutMicro = multiplyMicroByOdds(stake, topMultiplier);
        const meta: TippotMeta = {
          product: "tippot",
          n: quote.n,
          marginBp: quote.marginBp,
          tiers: quote.tiers,
        };
        betMeta = meta;
      } else if (betType === "betbuilder") {
        // BetBuilder. Validate the session is still valid via OBB
        // SessionInfo before we commit. If Oddin invalidated it (a
        // selection's price moved enough to recompute the session, the
        // session expired, …) we 503 betbuilder_session_invalid so the
        // client re-quotes.
        if (!obbBetsClient || !req.betBuilder) {
          // Already gated above — defence in depth.
          throw new BadRequestError(
            "betbuilder_block_required",
            "betbuilder_block_required",
          );
        }
        // Deep-fetch the match URN. We rely on the markets we just looked
        // up; every leg is from the same match since betBuilderMatchId
        // is enforced above.
        const firstMarketKey = req.selections[0]!.marketId;
        const firstMarket = marketByID.get(firstMarketKey)!;
        // We didn't pull providerUrn into rows (it's join-irrelevant for
        // the rest of the flow); fetch it once here.
        const matchRow = await tx
          .select({
            providerUrn: matches.providerUrn,
          })
          .from(matches)
          .where(eq(matches.id, firstMarket.matchId))
          .limit(1);
        const eventUrn = matchRow[0]?.providerUrn ?? "";
        if (!eventUrn) {
          throw new BadRequestError("match_not_open", "match_not_open");
        }

        let sessionInfo;
        try {
          sessionInfo = await obbBetsClient.sessionInfo({
            sessionId: req.betBuilder.sessionId,
            selectionIds: req.betBuilder.selectionIds,
            oddsX10000: req.betBuilder.expectedOddsX10000,
          });
        } catch (err) {
          // Network / TLS / Oddin downtime — surface as 503 so the slip
          // can retry. The placement attempt is already inside a
          // transaction; throwing rolls everything back.
          if (err instanceof ObbError) {
            throw new ServiceUnavailableError(
              "betbuilder_unavailable",
              err.message,
            );
          }
          throw err;
        }
        if (sessionInfo.status !== "valid") {
          throw new BadRequestError(
            "betbuilder_session_invalid",
            "betbuilder_session_invalid",
          );
        }

        const oddsX10000 = req.betBuilder.expectedOddsX10000;
        const decimalOdds = oddsX10000 / 10_000;
        // Same drift-tolerance contract: if the user submits an odds
        // value < 1.01 we refuse — Oddin shouldn't ever return one, but
        // defence in depth keeps a malformed client from locking stake
        // against a payout < stake.
        if (!Number.isFinite(decimalOdds) || decimalOdds < 1.01) {
          throw new BadRequestError(
            "betbuilder_odds_too_low",
            "betbuilder_odds_too_low",
          );
        }
        potentialPayoutMicro = multiplyMicroByOdds(stake, decimalOdds);
        const meta: BetBuilderMeta = {
          product: "betbuilder",
          sessionId: req.betBuilder.sessionId,
          sessionOddsMicro: potentialPayoutMicro.toString(),
          oddsX10000,
          eventUrn,
          selectionIds: req.betBuilder.selectionIds,
        };
        betMeta = meta;
      } else {
        // single / combo — existing odds-product math, now bigint-safe.
        // Combi Boost: only combo (>= 2 legs) ever reaches a tier;
        // single's leg count of 1 is below the minimum threshold so
        // computeCombiBoost returns multiplier 1.0 there. We still
        // route singles through the same branch to keep the no-boost
        // path cheap. Boosted combos freeze the multiplier into
        // bet_meta so settlement can re-apply it without recomputing
        // eligibility from leg odds (those may differ from final
        // settlement odds after voids).
        let combiMultiplier = 1.0;
        if (betType === "combo") {
          // Live admin-tunable config from /admin/combi-boost-config.
          // Read inside the placement transaction so a save in the
          // admin UI applies to the very next placement.
          const [cfgRow] = await tx
            .select()
            .from(combiBoostConfig)
            .where(eq(combiBoostConfig.id, "default"))
            .limit(1);
          const liveConfig = cfgRow
            ? {
                enabled: cfgRow.enabled,
                minOdds: Number(cfgRow.minOdds),
                tiers: [
                  {
                    minLegs: cfgRow.tier1MinLegs,
                    multiplier: Number(cfgRow.tier1Multiplier),
                    label: `x${Number(cfgRow.tier1Multiplier).toFixed(2)}`,
                  },
                  {
                    minLegs: cfgRow.tier2MinLegs,
                    multiplier: Number(cfgRow.tier2Multiplier),
                    label: `x${Number(cfgRow.tier2Multiplier).toFixed(2)}`,
                  },
                  {
                    minLegs: cfgRow.tier3MinLegs,
                    multiplier: Number(cfgRow.tier3Multiplier),
                    label: `x${Number(cfgRow.tier3Multiplier).toFixed(2)}`,
                  },
                  {
                    minLegs: cfgRow.tier4MinLegs,
                    multiplier: Number(cfgRow.tier4Multiplier),
                    label: `x${Number(cfgRow.tier4Multiplier).toFixed(2)}`,
                  },
                ],
              }
            : undefined;
          const boost = computeCombiBoost(
            req.selections.map((s) => s.odds),
            liveConfig,
          );
          combiMultiplier = boost.multiplier;
          // Per-bettor visibility (migration 0071). If the bettor has
          // combi_boost hidden on ANY leg's match / tournament / sport,
          // strip the multiplier — they're not allowed this promo on
          // this combo. Cheap check: cascade load is one indexed query,
          // and `cascades.empty` short-circuits to no work for users
          // without any rules.
          if (combiMultiplier > 1.0) {
            const promoCascades = await loadPromoVisibilityCascades(tx, ctx.userId);
            if (!promoCascades.combi_boost.empty) {
              for (const sel of req.selections) {
                const m = marketByID.get(sel.marketId);
                if (!m) continue;
                const visible = resolveVisible(promoCascades, "combi_boost", {
                  matchId: m.matchId,
                  tournamentId: m.tournamentId,
                  sportId: m.sportId,
                });
                if (!visible) {
                  combiMultiplier = 1.0;
                  break;
                }
              }
            }
          }
          if (combiMultiplier > 1.0) {
            const meta: ComboMeta = {
              product: "combo",
              boostMultiplier: combiMultiplier.toFixed(2),
              boostEligibleLegCount: boost.eligibleLegCount,
            };
            betMeta = meta;
          }
        }
        potentialPayoutMicro = multiplyMicroByOdds(
          stake,
          productOdds * combiMultiplier,
        );
      }

      // ── RiskZilla: pre-bet risk evaluation ───────────────────────────
      // Evaluates per-tier match liability, per-bettor slice, max
      // payout, min stake, market factor and the global bank limit.
      // OZ demo currency bypasses the engine inside evaluate().
      // First-leg's match drives the matchContext for the event_log
      // row — the betticker shows one row per attempt, and combos /
      // BetBuilder are clearly identifiable from `selections.length`
      // in `decision_meta.buckets`.
      const firstLegRow = marketByID.get(req.selections[0]!.marketId)!;
      const matchContext: RiskzillaMatchContext = {
        matchId: firstLegRow.matchId,
        sportId: firstLegRow.sportId,
        tournamentId: firstLegRow.tournamentId,
        riskTier: firstLegRow.tournamentRiskTier ?? null,
      };
      const riskIntent: RiskzillaIntent = {
        userId: ctx.userId,
        currency,
        stakeMicro: stake,
        potentialPayoutMicro,
        userStatus: user.status,
        userRiskScore: Number(user.riskScore),
        legs: req.selections.map<RiskzillaIntentLeg>((s) => {
          const m = marketByID.get(s.marketId)!;
          return {
            marketId: BigInt(s.marketId),
            outcomeId: s.outcomeId,
            matchId: m.matchId,
            providerMarketId: m.providerMarketId,
            sportId: m.sportId,
            tournamentId: m.tournamentId,
            riskTier: m.tournamentRiskTier ?? null,
            oddsAtPlacement: Number(s.odds),
          };
        }),
      };
      // Wrap the engine call so any unexpected throw becomes a typed
      // error with structured logs instead of a 500 "Something went
      // wrong". Engine bugs (a missing config row, a SQL hiccup, etc.)
      // shouldn't cascade into an opaque generic error for the bettor.
      // Fail-closed: if the engine can't evaluate, we refuse the bet
      // rather than letting unchecked liability through.
      let riskResult: Awaited<ReturnType<typeof this.riskzilla.evaluate>>;
      try {
        riskResult = await this.riskzilla.evaluate(tx, riskIntent);
      } catch (engineErr) {
        // Re-throw the rejection sentinel unchanged — that's not an
        // engine error, that's a normal rejection thrown via `throw`.
        if (engineErr instanceof RiskzillaRejectError) throw engineErr;
        // Any other exception: log with full context, then surface as
        // a typed 400 the slip can render meaningfully.
        // eslint-disable-next-line no-console
        console.error("riskzilla.engine_error", {
          userId: ctx.userId,
          currency,
          stakeMicro: stake.toString(),
          potentialPayoutMicro: potentialPayoutMicro.toString(),
          legs: riskIntent.legs.length,
          error:
            engineErr instanceof Error
              ? { name: engineErr.name, message: engineErr.message }
              : String(engineErr),
        });
        throw new BadRequestError("riskzilla_engine_error", "riskzilla_engine_error");
      }
      if (riskResult.decision !== "accepted") {
        // Log every rejection at info level so ops can see what gates
        // are firing without scraping the event_log table. The full
        // bucket-level breakdown still lands in `decision_meta`.
        // eslint-disable-next-line no-console
        console.info("riskzilla.rejected", {
          userId: ctx.userId,
          decision: riskResult.decision,
          reason: riskResult.reason,
          stakeMicro: stake.toString(),
          potentialPayoutMicro: potentialPayoutMicro.toString(),
          matchId: matchContext.matchId?.toString() ?? null,
          riskTier: matchContext.riskTier,
        });
        // Throw out of the tx (rolls back). place() catches the
        // sentinel below, writes the rejection row outside the
        // rolled-back tx, and re-throws as a typed BadRequestError.
        throw new RiskzillaRejectError(riskResult, riskIntent, matchContext);
      }

      // ── Resolve effective acceptance delay ───────────────────────────
      // The acceptance delay is a LIVE-only safeguard — prematch markets
      // don't move fast enough to justify holding the placement, and the
      // bet-delay worker's drift / suspended re-check would dead-end on
      // odds that, by definition, can't have moved yet. Two sources, both
      // gated on at least one live leg:
      //   - users.bet_delay_seconds — per-user knob (admin sets it for
      //     bettors that need extra scrutiny on live placements)
      //   - riskzilla_live_delay_config — cascade override per
      //     match / tournament / sport / global
      // Per-leg cascade: match > tournament > sport > global. Across
      // legs: MAX (worst-case window). Final delay = MAX(user, cascade).
      // PURE-PREMATCH PLACEMENTS GET ZERO DELAY — even when the bettor's
      // bet_delay_seconds is set, the per-user knob only kicks in once a
      // live leg lands in the ticket.
      const liveLegs = req.selections
        .map((s) => marketByID.get(s.marketId)!)
        .filter((m) => m.matchStatus === "live");
      let effectiveDelaySeconds = 0;
      if (liveLegs.length > 0) {
        const matchIds = Array.from(new Set(liveLegs.map((m) => m.matchId)));
        const tournamentIds = Array.from(
          new Set(liveLegs.map((m) => m.tournamentId)),
        );
        const sportIds = Array.from(new Set(liveLegs.map((m) => m.sportId)));

        const cfgRows = await tx
          .select()
          .from(riskzillaLiveDelayConfig)
          .where(
            or(
              eq(riskzillaLiveDelayConfig.scope, "global"),
              and(
                eq(riskzillaLiveDelayConfig.scope, "sport"),
                inArray(riskzillaLiveDelayConfig.sportId, sportIds),
              ),
              and(
                eq(riskzillaLiveDelayConfig.scope, "tournament"),
                inArray(riskzillaLiveDelayConfig.tournamentId, tournamentIds),
              ),
              and(
                eq(riskzillaLiveDelayConfig.scope, "match"),
                inArray(riskzillaLiveDelayConfig.matchId, matchIds),
              ),
            ),
          );

        let globalDelay = 0;
        const sportDelay = new Map<number, number>();
        const tournamentDelay = new Map<number, number>();
        const matchDelay = new Map<string, number>();
        for (const r of cfgRows) {
          switch (r.scope) {
            case "global":
              globalDelay = r.delaySeconds;
              break;
            case "sport":
              if (r.sportId !== null) sportDelay.set(r.sportId, r.delaySeconds);
              break;
            case "tournament":
              if (r.tournamentId !== null) {
                tournamentDelay.set(r.tournamentId, r.delaySeconds);
              }
              break;
            case "match":
              if (r.matchId !== null) {
                matchDelay.set(r.matchId.toString(), r.delaySeconds);
              }
              break;
          }
        }
        let liveCascadeDelay = 0;
        for (const leg of liveLegs) {
          const v =
            matchDelay.get(leg.matchId.toString()) ??
            tournamentDelay.get(leg.tournamentId) ??
            sportDelay.get(leg.sportId) ??
            globalDelay;
          if (v > liveCascadeDelay) liveCascadeDelay = v;
        }
        effectiveDelaySeconds = Math.max(user.betDelaySeconds, liveCascadeDelay);
        // ZillaFlash live boost: -2 s acceptance shave. Documented in
        // PlaceContext.zillaFlashLiveBoost. Clamped at 0 so a 1 s
        // per-match delay can't drop to negative and shortcut the
        // worker's "drift check" path entirely; if you want zero, set
        // the per-match override to ≤ 2 s explicitly.
        if (ctx.zillaFlashLiveBoost) {
          effectiveDelaySeconds = Math.max(
            0,
            effectiveDelaySeconds - 2,
          );
        }
      }

      // ── Insert ticket ────────────────────────────────────────────────
      const now = new Date();
      const delayed = effectiveDelaySeconds > 0;
      const notBefore = delayed
        ? new Date(now.getTime() + effectiveDelaySeconds * 1000)
        : null;
      const status = delayed ? ("pending_delay" as const) : ("accepted" as const);
      const acceptedAt = delayed ? null : now;

      // Per-product gating for the accept-odds-changes flag. Only
      // single + combo can be re-priced against the latest published
      // price during the bet-delay window — tiple / tippot anchor on
      // probabilities frozen at placement, and betbuilder pays at the
      // OBB session odds (which already abstract over per-leg drift).
      // Silently ignoring it for other products keeps the API contract
      // tolerant while making the flag a no-op where it doesn't apply.
      const acceptOddsChanges =
        (req.acceptOddsChanges ?? false) &&
        (betType === "single" || betType === "combo");

      const [inserted] = await tx
        .insert(tickets)
        .values({
          userId: ctx.userId,
          status,
          betType,
          currency,
          stakeMicro: stake,
          potentialPayoutMicro,
          idempotencyKey: req.idempotencyKey,
          notBeforeTs: notBefore,
          placedAt: now,
          acceptedAt,
          clientIp: ctx.ip,
          userAgent: ctx.userAgent,
          betMeta: betMeta as unknown as Record<string, unknown> | null,
          acceptOddsChanges,
        })
        // Two concurrent placements with the same idempotencyKey both
        // pass the SELECT-then-INSERT check above; the unique
        // constraint blocks the second. ON CONFLICT DO NOTHING converts
        // the loser into a no-op so we re-fetch the original ticket
        // instead of throwing a 500. The pre-check still catches a
        // user-A vs user-B collision (caller-side races stay 409). M-3.
        .onConflictDoNothing({ target: tickets.idempotencyKey })
        .returning();
      if (!inserted) {
        // Loser of the concurrent insert race — re-fetch and surface
        // the same ticket the winner created.
        const again = await tx
          .select()
          .from(tickets)
          .where(eq(tickets.idempotencyKey, req.idempotencyKey))
          .limit(1);
        if (again.length === 0) {
          throw new Error("ticket insert returned no row");
        }
        if (again[0]!.userId !== ctx.userId) {
          throw new ConflictError("idempotency_key_collision", "idempotency_key_collision");
        }
        return this.hydrateSummary(tx, again[0]!.id);
      }

      // ── Insert selections ────────────────────────────────────────────
      // Snapshot the leg's win probability at placement time. Cashout uses
      // it as "ticket value at placement" (Sportradar §1.2) and the
      // significant-change gate; tiple/tippot use it for the math the
      // server priced from. Null when the feed hasn't shipped one yet
      // (rare; cashout falls back to 1/odds, tiple/tippot reject earlier
      // via outcome_no_probability).
      await tx.insert(ticketSelections).values(
        req.selections.map((s) => {
          const outcome = outcomeByKey.get(`${s.marketId}:${s.outcomeId}`)!;
          return {
            ticketId: inserted.id,
            marketId: BigInt(s.marketId),
            outcomeId: s.outcomeId,
            oddsAtPlacement: s.odds,
            probabilityAtPlacement: outcome.probability ?? null,
          };
        }),
      );

      // ── Lock stake on wallet + audit ledger ──────────────────────────
      await tx
        .update(wallets)
        .set({
          lockedMicro: sql`${wallets.lockedMicro} + ${stake}`,
          updatedAt: new Date(),
        })
        .where(
          and(eq(wallets.userId, ctx.userId), eq(wallets.currency, currency)),
        );

      await tx.insert(walletLedger).values({
        userId: ctx.userId,
        currency,
        deltaMicro: -stake,
        type: "bet_stake",
        refType: "ticket",
        refId: inserted.id,
        memo: null,
      });

      // ── RiskZilla: persist accepted-bet bookkeeping ──────────────────
      // Bumps open_liability_micro on the bank state row + writes the
      // event_log row with the freshly-minted ticket_id.
      await this.riskzilla.commitAccepted(
        tx,
        inserted.id,
        riskIntent,
        riskResult,
        matchContext,
      );

      // ── pg_notify the bet-delay worker ───────────────────────────────
      if (delayed) {
        await tx.execute(sql`SELECT pg_notify('bet_delay', ${inserted.id})`);
      }

      return this.hydrateSummary(tx, inserted.id);
      });
    } catch (err) {
      // RiskZilla rejection sentinel — record the decision row outside
      // the rolled-back tx so the betticker / bets pages see it, then
      // surface a typed BadRequestError to the client. Log every
      // logging failure so silent event_log drops don't go unnoticed
      // (the betticker would otherwise show "no events" indefinitely).
      if (err instanceof RiskzillaRejectError) {
        try {
          await this.riskzilla.recordRejection(err.intent, err.result, err.matchContext);
        } catch (logErr) {
          // eslint-disable-next-line no-console
          console.error("riskzilla.record_rejection_failed", {
            userId: err.intent.userId,
            decision: err.result.decision,
            error:
              logErr instanceof Error
                ? { name: logErr.name, message: logErr.message }
                : String(logErr),
          });
        }
        throw new BadRequestError(err.result.reason, err.result.decision);
      }
      throw err;
    }

    // Best-effort WS push to user channel so the slip UI updates without
    // polling. DB is source of truth — pub/sub drops are tolerable.
    try {
      await this.redis.publish(
        USER_CHANNEL_PREFIX + ctx.userId,
        JSON.stringify({
          type: "ticket",
          ticketId: placed.id,
          status: placed.status,
          rejectReason: placed.rejectReason,
          actualPayoutMicro: placed.actualPayoutMicro,
        }),
      );
    } catch {
      // ignore
    }

    return placed;
  }

  /** List a user's tickets, newest first. */
  async listForUser(userId: string, limit = 50): Promise<TicketSummary[]> {
    const ticketRows = await this.db
      .select()
      .from(tickets)
      .where(eq(tickets.userId, userId))
      .orderBy(sql`${tickets.placedAt} DESC`)
      .limit(limit);
    if (ticketRows.length === 0) return [];

    const ids = ticketRows.map((t) => t.id);
    const selRows = await selectSelectionRows(
      this.db,
      inArray(ticketSelections.ticketId, ids),
    );

    const byTicket = new Map<string, Array<(typeof selRows)[number]>>();
    for (const r of selRows) {
      const list = byTicket.get(r.sel.ticketId) ?? [];
      list.push(r);
      byTicket.set(r.sel.ticketId, list);
    }

    const descMap = await loadMarketDescriptionMap(this.db, selRows);
    return ticketRows.map((t) =>
      this.summaryFromRows(t, byTicket.get(t.id) ?? [], descMap),
    );
  }

  async getOne(userId: string, ticketId: string): Promise<TicketSummary | null> {
    const [t] = await this.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.userId, userId)))
      .limit(1);
    if (!t) return null;
    return this.hydrateSummary(this.db, t.id);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async hydrateSummary(
    db: DbClient | TxHandle,
    ticketId: string,
  ): Promise<TicketSummary> {
    const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
    if (!t) throw new Error("ticket not found after insert");

    const selRows = await selectSelectionRows(
      db,
      eq(ticketSelections.ticketId, t.id),
    );

    const descMap = await loadMarketDescriptionMap(db, selRows);
    return this.summaryFromRows(t, selRows, descMap);
  }

  private summaryFromRows(
    t: typeof tickets.$inferSelect,
    rows: Array<{
      sel: typeof ticketSelections.$inferSelect;
      providerMarketId: number | null;
      specifiersJson: unknown;
      marketStatus: number | null;
      matchId: bigint | null;
      homeTeam: string | null;
      awayTeam: string | null;
      matchStatus:
        | "not_started"
        | "live"
        | "closed"
        | "cancelled"
        | "suspended"
        | null;
      sportSlug: string | null;
      currentOdds: string | null;
      outcomeActive: boolean | null;
      outcomeName: string | null;
    }>,
    marketDescMap: Map<string, string>,
  ): TicketSummary {
    const ticketCurrency = (t.currency.trim() as Currency) ?? DEFAULT_CURRENCY;
    return {
      id: t.id,
      status: t.status,
      betType: t.betType,
      currency: ticketCurrency,
      stakeMicro: t.stakeMicro.toString(),
      potentialPayoutMicro: t.potentialPayoutMicro.toString(),
      actualPayoutMicro:
        t.actualPayoutMicro !== null ? t.actualPayoutMicro.toString() : null,
      notBeforeTs: t.notBeforeTs?.toISOString() ?? null,
      rejectReason: t.rejectReason,
      placedAt: t.placedAt.toISOString(),
      acceptedAt: t.acceptedAt?.toISOString() ?? null,
      settledAt: t.settledAt?.toISOString() ?? null,
      acceptOddsChanges: t.acceptOddsChanges,
      betMeta: (t.betMeta ?? null) as TicketSummary["betMeta"],
      selections: rows.map((r) => {
        if (r.matchId === null || r.providerMarketId === null) {
          return {
            marketId: r.sel.marketId.toString(),
            outcomeId: r.sel.outcomeId,
            oddsAtPlacement: r.sel.oddsAtPlacement,
            probabilityAtPlacement: r.sel.probabilityAtPlacement ?? null,
            result: r.sel.result,
            voidFactor: r.sel.voidFactor,
            market: undefined,
          };
        }
        const specs = (r.specifiersJson ?? {}) as Record<string, string>;
        const variant = specs.variant ?? "";
        // Locale-prefer the variant-specific template, fall back to the
        // empty-variant template. Both with `language='en'` — bet
        // routes don't pipe locale through today; pre-render here to
        // keep the API surface flat. Localising the marketName is a
        // follow-up (read locale from the route, plumb to the map
        // loader, and prefer locale rows over `en`).
        const template =
          marketDescMap.get(`${r.providerMarketId}:${variant}`) ??
          marketDescMap.get(`${r.providerMarketId}:`) ??
          "";
        const marketName = template
          ? substituteTemplate(
              template,
              specs,
              { homeTeam: r.homeTeam ?? "", awayTeam: r.awayTeam ?? "" },
              undefined,
              "en",
            )
          : "";
        return {
          marketId: r.sel.marketId.toString(),
          outcomeId: r.sel.outcomeId,
          oddsAtPlacement: r.sel.oddsAtPlacement,
          probabilityAtPlacement: r.sel.probabilityAtPlacement ?? null,
          result: r.sel.result,
          voidFactor: r.sel.voidFactor,
          market: {
            providerMarketId: r.providerMarketId,
            specifiers: specs,
            matchId: r.matchId.toString(),
            homeTeam: r.homeTeam ?? "",
            awayTeam: r.awayTeam ?? "",
            sportSlug: r.sportSlug ?? "",
            marketName,
            outcomeName: r.outcomeName ?? "",
            matchStatus: r.matchStatus ?? "not_started",
            currentOdds: r.currentOdds,
            // markets.status=1 + market_outcomes.active=true is the
            // exact gate POST /bets re-validates against; mirror it
            // here so the UI can show "currently bettable" with the
            // same definition.
            currentlyActive:
              r.marketStatus === 1 && r.outcomeActive === true,
          },
        };
      }),
    };
  }
}

function parseBigIntStrict(raw: string, field: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestError(`${field}_must_be_positive_integer`, `${field}_must_be_positive_integer`);
  }
  return BigInt(raw);
}
