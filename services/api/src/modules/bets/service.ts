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
import { eq, and, inArray, sql } from "drizzle-orm";
import type { DbClient } from "@oddzilla/db";
import {
  users,
  wallets,
  walletLedger,
  markets,
  marketOutcomes,
  matches,
  tickets,
  ticketSelections,
  sports,
  categories,
  tournaments,
  betProductConfig,
} from "@oddzilla/db";
import {
  DEFAULT_CURRENCY,
  DEFAULT_ODDS_DRIFT_TOLERANCE,
  isCurrency,
  parseProbability,
  priceTiple,
  priceTippot,
  type BetMeta,
  type BetType,
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
  UnauthorizedError,
} from "../../lib/errors.js";

const USER_CHANNEL_PREFIX = "user:";

type TxHandle = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

interface PlaceContext {
  userId: string;
  ip: string | null;
  userAgent: string | null;
}

export class BetsService {
  constructor(
    private readonly db: DbClient,
    private readonly redis: Redis,
  ) {}

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
    // upgrade users into a different product).
    const betType: BetType =
      req.betType ?? (req.selections.length > 1 ? "combo" : "single");
    const isMultiLeg = req.selections.length > 1;
    const isProductBet = betType === "tiple" || betType === "tippot";
    if (betType === "single" && req.selections.length !== 1) {
      throw new BadRequestError("single_requires_one_leg", "single_requires_one_leg");
    }
    if ((betType === "combo" || isProductBet) && !isMultiLeg) {
      throw new BadRequestError("multi_leg_required", "multi_leg_required");
    }
    if (betType === "system") {
      // Reserved enum value; not yet implemented in any layer.
      throw new BadRequestError("bet_type_unsupported", "bet_type_unsupported");
    }
    if (isMultiLeg) {
      // Same-match combos / tiples / tippots are a related-contingency
      // (the outcomes aren't independent) — standard bookmaker rule is to
      // block them. For probability-driven products this also breaks the
      // independence assumption baked into the math.
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

    const placed = await this.db.transaction(async (tx) => {
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
      let productCfg: { marginBp: number; minLegs: number; maxLegs: number; enabled: boolean } | null = null;
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

      let productOdds = 1;
      const seenMatchIds = new Set<string>();
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
        if (isMultiLeg) {
          const matchKey = market.matchId.toString();
          if (seenMatchIds.has(matchKey)) {
            throw new BadRequestError("combo_same_match", "combo_same_match");
          }
          seenMatchIds.add(matchKey);
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
        const drift = Math.abs(currentOdds - submittedOdds) / submittedOdds;
        if (drift > tolerance) {
          throw new BadRequestError("odds_drift_exceeded", "odds_drift_exceeded");
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
      let potentialPayoutMicro: bigint;
      let betMeta: BetMeta | null = null;
      if (betType === "tiple") {
        const quote = priceTiple(probabilities, productCfg!.marginBp);
        if (Number(quote.offeredOdds) < 1.01) {
          // Refuse offered < 1.01 — bettor would lose money on a winning
          // ticket. Mirrors the floor odds-publisher applies elsewhere.
          throw new BadRequestError("tiple_odds_too_low", "tiple_odds_too_low");
        }
        potentialPayoutMicro = BigInt(
          Math.floor(Number(stake) * Number(quote.offeredOdds)),
        );
        const meta: TipleMeta = {
          product: "tiple",
          n: quote.n,
          marginBp: quote.marginBp,
          fairProbability: quote.fairProbability.toFixed(6),
        };
        betMeta = meta;
      } else if (betType === "tippot") {
        const quote = priceTippot(probabilities, productCfg!.marginBp);
        // Top tier (all legs win) sets the displayed potential payout —
        // matches what users intuitively expect to see in the slip.
        const topMultiplier = Number(quote.tiers[quote.tiers.length - 1]!.multiplier);
        potentialPayoutMicro = BigInt(Math.floor(Number(stake) * topMultiplier));
        const meta: TippotMeta = {
          product: "tippot",
          n: quote.n,
          marginBp: quote.marginBp,
          tiers: quote.tiers,
        };
        betMeta = meta;
      } else {
        // single / combo — existing odds-product math.
        potentialPayoutMicro = BigInt(
          Math.floor(Number(stake) * productOdds),
        );
      }

      // ── Insert ticket ────────────────────────────────────────────────
      const now = new Date();
      const delayed = user.betDelaySeconds > 0;
      const notBefore = delayed ? new Date(now.getTime() + user.betDelaySeconds * 1000) : null;
      const status = delayed ? ("pending_delay" as const) : ("accepted" as const);
      const acceptedAt = delayed ? null : now;

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
        })
        .returning();
      if (!inserted) {
        // ON CONFLICT path shouldn't hit here because we checked above,
        // but belt + suspenders: re-fetch.
        const again = await tx
          .select()
          .from(tickets)
          .where(eq(tickets.idempotencyKey, req.idempotencyKey))
          .limit(1);
        if (again.length === 0) {
          throw new Error("ticket insert returned no row");
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

      // ── pg_notify the bet-delay worker ───────────────────────────────
      if (delayed) {
        await tx.execute(sql`SELECT pg_notify('bet_delay', ${inserted.id})`);
      }

      return this.hydrateSummary(tx, inserted.id);
    });

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
    const selRows = await this.db
      .select({
        sel: ticketSelections,
        providerMarketId: markets.providerMarketId,
        specifiersJson: markets.specifiersJson,
        matchId: matches.id,
        homeTeam: matches.homeTeam,
        awayTeam: matches.awayTeam,
        sportSlug: sports.slug,
      })
      .from(ticketSelections)
      .leftJoin(markets, eq(markets.id, ticketSelections.marketId))
      .leftJoin(matches, eq(matches.id, markets.matchId))
      .leftJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .leftJoin(categories, eq(categories.id, tournaments.categoryId))
      .leftJoin(sports, eq(sports.id, categories.sportId))
      .where(inArray(ticketSelections.ticketId, ids));

    const byTicket = new Map<string, Array<(typeof selRows)[number]>>();
    for (const r of selRows) {
      const list = byTicket.get(r.sel.ticketId) ?? [];
      list.push(r);
      byTicket.set(r.sel.ticketId, list);
    }

    return ticketRows.map((t) =>
      this.summaryFromRows(t, byTicket.get(t.id) ?? []),
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

    const selRows = await db
      .select({
        sel: ticketSelections,
        providerMarketId: markets.providerMarketId,
        specifiersJson: markets.specifiersJson,
        matchId: matches.id,
        homeTeam: matches.homeTeam,
        awayTeam: matches.awayTeam,
        sportSlug: sports.slug,
      })
      .from(ticketSelections)
      .leftJoin(markets, eq(markets.id, ticketSelections.marketId))
      .leftJoin(matches, eq(matches.id, markets.matchId))
      .leftJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .leftJoin(categories, eq(categories.id, tournaments.categoryId))
      .leftJoin(sports, eq(sports.id, categories.sportId))
      .where(eq(ticketSelections.ticketId, t.id));

    return this.summaryFromRows(t, selRows);
  }

  private summaryFromRows(
    t: typeof tickets.$inferSelect,
    rows: Array<{
      sel: typeof ticketSelections.$inferSelect;
      providerMarketId: number | null;
      specifiersJson: unknown;
      matchId: bigint | null;
      homeTeam: string | null;
      awayTeam: string | null;
      sportSlug: string | null;
    }>,
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
      betMeta: (t.betMeta ?? null) as TicketSummary["betMeta"],
      selections: rows.map((r) => ({
        marketId: r.sel.marketId.toString(),
        outcomeId: r.sel.outcomeId,
        oddsAtPlacement: r.sel.oddsAtPlacement,
        probabilityAtPlacement: r.sel.probabilityAtPlacement ?? null,
        result: r.sel.result,
        voidFactor: r.sel.voidFactor,
        market:
          r.matchId !== null && r.providerMarketId !== null
            ? {
                providerMarketId: r.providerMarketId,
                specifiers: (r.specifiersJson ?? {}) as Record<string, string>,
                matchId: r.matchId.toString(),
                homeTeam: r.homeTeam ?? "",
                awayTeam: r.awayTeam ?? "",
                sportSlug: r.sportSlug ?? "",
              }
            : undefined,
      })),
    };
  }
}

function parseBigIntStrict(raw: string, field: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new BadRequestError(`${field}_must_be_positive_integer`, `${field}_must_be_positive_integer`);
  }
  return BigInt(raw);
}
