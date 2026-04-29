// Cashout service. Two operations:
//
//   quote(userId, ticketId)
//     Loads the ticket, walks the cashout_config cascade, computes the
//     current offer via the pure algorithm, and persists the result as
//     a `cashouts` row in `offered` status. Returns CashoutQuote.
//
//   accept(userId, ticketId, quoteId, expectedOfferMicro)
//     1. Pre-validates the quote (status, freshness, amount).
//     2. If the resolved cashout_config has acceptanceDelaySeconds > 0,
//        sleeps that many seconds (no DB locks held). Mirrors the
//        bet-placement bet_delay_seconds — gives the bookmaker a window
//        to bail if the underlying probability moves against them.
//     3. Recomputes the current offer; if it dropped by more than the
//        drift tolerance from the quoted amount, rejects.
//     4. Transactional commit: ticket → cashed_out, wallet credit at
//        the ORIGINAL quoted amount, wallet_ledger row keyed apply-once
//        on (cashout, ticket, ticket_id).

import { Redis } from "ioredis";
import { eq, and, sql } from "drizzle-orm";
import type { DbClient } from "@oddzilla/db";
import {
  tickets,
  ticketSelections,
  markets,
  marketOutcomes,
  matches,
  sports,
  categories,
  tournaments,
  cashoutConfig,
  cashouts,
  wallets,
  walletLedger,
} from "@oddzilla/db";
import type { CashoutQuote, CashoutLadderStep } from "@oddzilla/types";
import {
  ConflictError,
  NotFoundError,
  ForbiddenError,
} from "../../lib/errors.js";
import { compute } from "./algorithm.js";

// Quote validity. Long enough for the user to read + click + sit
// through the acceptance delay; short enough that stale offers don't
// stay on the wire.
const QUOTE_TTL_SECONDS = 30;

// During the acceptance delay we tolerate this much downward drift in
// the recomputed offer before rejecting. 5% mirrors the placement
// odds-drift tolerance.
const ACCEPTANCE_DRIFT_TOLERANCE = 0.05;

const USER_CHANNEL_PREFIX = "user:";

interface ResolvedConfig {
  enabled: boolean;
  prematchFullPaybackSeconds: number;
  deductionLadder: CashoutLadderStep[] | null;
  minOfferMicro: bigint;
  minValueChangeBp: number;
  acceptanceDelaySeconds: number;
}

export class CashoutService {
  constructor(
    private readonly db: DbClient,
    private readonly redis: Redis,
  ) {}

  /**
   * Generate a fresh quote and persist as `offered`.
   */
  async quote(userId: string, ticketId: string): Promise<CashoutQuote> {
    const ticket = await this.loadTicket(userId, ticketId);

    if (ticket.status !== "accepted") {
      return {
        available: false,
        reason: "not_open",
        ticketStakeMicro: ticket.stakeMicro.toString(),
      };
    }

    const legs = await this.loadLegs(ticketId);
    if (legs.length === 0) {
      return {
        available: false,
        reason: "not_open",
        ticketStakeMicro: ticket.stakeMicro.toString(),
      };
    }

    const config = await this.resolveConfig(legs);
    const matchEarliestKickoffMs = legs.reduce<number | null>((acc, l) => {
      if (!l.matchScheduledAt) return acc;
      const ms = l.matchScheduledAt.getTime();
      return acc === null || ms < acc ? ms : acc;
    }, null);

    const result = compute({
      betType: ticket.betType,
      stakeMicro: ticket.stakeMicro,
      potentialPayoutMicro: ticket.potentialPayoutMicro,
      placedAtMs: ticket.placedAt.getTime(),
      matchEarliestKickoffMs,
      legs: legs.map((l) => ({
        oddsAtPlacement: l.oddsAtPlacement,
        probabilityCurrent: l.probability !== null ? Number(l.probability) : null,
        oddsCurrent: l.publishedOdds,
        active: (l.active ?? false) && l.marketStatus === 1,
        result: l.result,
        voidFactor: l.voidFactor,
      })),
      config,
      nowMs: Date.now(),
    });

    const baseQuote: CashoutQuote = {
      available: result.available,
      reason: result.reason,
      ticketStakeMicro: ticket.stakeMicro.toString(),
      ticketOdds: result.ticketOdds.toFixed(4),
      probability: result.probability.toFixed(7),
      ticketValueFairMicro: result.ticketValueFairMicro.toString(),
      deductionFactor:
        result.deductionFactor !== null
          ? result.deductionFactor.toFixed(4)
          : undefined,
      fullPayback: result.fullPayback,
      acceptanceDelaySeconds: config.acceptanceDelaySeconds,
    };

    if (!result.available) {
      // We deliberately do NOT persist a row for unavailable quotes
      // anymore. Polling at 5s with 1000+ users would otherwise burn
      // the cashouts table at ~12k rows/min. Audit signal we lose:
      // why a particular ticket showed "unavailable". Acceptable —
      // the user-facing message already names the reason.
      return baseQuote;
    }

    const expiresAt = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000);
    const [persisted] = await this.db
      .insert(cashouts)
      .values({
        ticketId,
        userId,
        status: "offered",
        offeredMicro: result.offerMicro,
        ticketOddsSnapshot: result.ticketOdds.toFixed(4),
        probabilitySnapshot: result.probability.toFixed(15),
        deductionFactorSnapshot:
          result.deductionFactor !== null
            ? result.deductionFactor.toFixed(4)
            : null,
        expiresAt,
      })
      .returning();
    if (!persisted) {
      throw new Error("cashout insert returned no row");
    }

    return {
      ...baseQuote,
      quoteId: persisted.id,
      offerMicro: result.offerMicro.toString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Accept a previously-issued quote. Two-phase:
   *   1. Pre-validate without locks.
   *   2. Sleep cashout_config.acceptance_delay_seconds (resolved across
   *      legs).
   *   3. Recompute the offer; reject if drifted beyond tolerance.
   *   4. Transactional commit at the ORIGINAL quoted amount.
   */
  async accept(
    userId: string,
    ticketId: string,
    quoteId: string,
    expectedOfferMicro: bigint,
  ): Promise<{ payoutMicro: bigint; cashedOutAt: Date }> {
    // ── Phase 1: pre-validate (no locks) ──────────────────────────────
    const [quote] = await this.db
      .select()
      .from(cashouts)
      .where(and(eq(cashouts.id, quoteId), eq(cashouts.ticketId, ticketId)))
      .limit(1);
    if (!quote) throw new NotFoundError("quote_not_found", "quote_not_found");
    if (quote.userId !== userId) {
      throw new ForbiddenError("quote_other_user", "quote_other_user");
    }
    if (quote.status !== "offered") {
      throw new ConflictError(`quote_${quote.status}`, `quote_${quote.status}`);
    }
    if (quote.expiresAt.getTime() < Date.now()) {
      await this.db
        .update(cashouts)
        .set({ status: "expired" })
        .where(eq(cashouts.id, quoteId));
      throw new ConflictError("quote_expired", "quote_expired");
    }
    if (quote.offeredMicro !== expectedOfferMicro) {
      throw new ConflictError("quote_amount_mismatch", "quote_amount_mismatch");
    }

    const ticketBefore = await this.loadTicket(userId, ticketId);
    if (ticketBefore.status !== "accepted") {
      throw new ConflictError(
        `ticket_${ticketBefore.status}`,
        `ticket_${ticketBefore.status}`,
      );
    }

    const legs = await this.loadLegs(ticketId);
    const resolvedConfig = await this.resolveConfig(legs);

    // ── Phase 2: acceptance delay (no locks) ──────────────────────────
    if (resolvedConfig.acceptanceDelaySeconds > 0) {
      await sleep(resolvedConfig.acceptanceDelaySeconds * 1000);
    }

    // ── Phase 3: recompute + drift check ──────────────────────────────
    const freshLegs = await this.loadLegs(ticketId);
    const matchEarliestKickoffMs = freshLegs.reduce<number | null>((acc, l) => {
      if (!l.matchScheduledAt) return acc;
      const ms = l.matchScheduledAt.getTime();
      return acc === null || ms < acc ? ms : acc;
    }, null);

    const recomputed = compute({
      betType: ticketBefore.betType,
      stakeMicro: ticketBefore.stakeMicro,
      potentialPayoutMicro: ticketBefore.potentialPayoutMicro,
      placedAtMs: ticketBefore.placedAt.getTime(),
      matchEarliestKickoffMs,
      legs: freshLegs.map((l) => ({
        oddsAtPlacement: l.oddsAtPlacement,
        probabilityCurrent: l.probability !== null ? Number(l.probability) : null,
        oddsCurrent: l.publishedOdds,
        active: (l.active ?? false) && l.marketStatus === 1,
        result: l.result,
        voidFactor: l.voidFactor,
      })),
      config: resolvedConfig,
      nowMs: Date.now(),
    });

    // If the offer is no longer available (a leg went inactive, lost,
    // etc.) or has dropped beyond the drift tolerance, reject.
    const driftFloor =
      (Number(quote.offeredMicro) * (1 - ACCEPTANCE_DRIFT_TOLERANCE)) | 0;
    if (!recomputed.available || Number(recomputed.offerMicro) < driftFloor) {
      await this.db
        .update(cashouts)
        .set({
          status: "errored",
          reason: !recomputed.available
            ? `drift_${recomputed.reason ?? "unavailable"}`
            : "drift_offer_dropped",
        })
        .where(eq(cashouts.id, quoteId));
      throw new ConflictError("offer_drifted", "offer_drifted");
    }

    // ── Phase 4: transactional commit ────────────────────────────────
    const placed = await this.db.transaction(async (tx) => {
      // Re-load with FOR UPDATE so we serialize against any concurrent
      // accept of the same quote.
      const [lockedQuote] = await tx
        .select()
        .from(cashouts)
        .where(eq(cashouts.id, quoteId))
        .for("update")
        .limit(1);
      if (!lockedQuote) {
        throw new NotFoundError("quote_not_found", "quote_not_found");
      }
      if (lockedQuote.status !== "offered") {
        throw new ConflictError(
          `quote_${lockedQuote.status}`,
          `quote_${lockedQuote.status}`,
        );
      }

      const [ticket] = await tx
        .select()
        .from(tickets)
        .where(and(eq(tickets.id, ticketId), eq(tickets.userId, userId)))
        .for("update")
        .limit(1);
      if (!ticket) throw new NotFoundError("ticket_not_found", "ticket_not_found");
      if (ticket.status !== "accepted") {
        throw new ConflictError(
          `ticket_${ticket.status}`,
          `ticket_${ticket.status}`,
        );
      }

      const [wallet] = await tx
        .select()
        .from(wallets)
        .where(
          and(eq(wallets.userId, userId), eq(wallets.currency, ticket.currency)),
        )
        .for("update")
        .limit(1);
      if (!wallet) {
        throw new NotFoundError("wallet_not_found", "wallet_not_found");
      }

      const cashedOutAt = new Date();
      const stake = ticket.stakeMicro;
      const offer = lockedQuote.offeredMicro;
      // Wallet delta: at placement we did `locked += stake` without
      // touching balance. On cashout: `balance += offer - stake` and
      // `locked -= stake` to release the hold.
      await tx
        .update(wallets)
        .set({
          balanceMicro: sql`${wallets.balanceMicro} + ${offer} - ${stake}`,
          lockedMicro: sql`${wallets.lockedMicro} - ${stake}`,
          updatedAt: cashedOutAt,
        })
        .where(
          and(eq(wallets.userId, userId), eq(wallets.currency, ticket.currency)),
        );

      // Apply-once ledger row keyed (type=cashout, ref_type=ticket,
      // ref_id=ticket_id) — unique partial index makes retries no-ops.
      await tx.insert(walletLedger).values({
        userId,
        currency: ticket.currency,
        deltaMicro: offer - stake,
        type: "cashout",
        refType: "ticket",
        refId: ticketId,
        memo: `cashout offer ${offer.toString()} for stake ${stake.toString()}`,
      });

      await tx
        .update(tickets)
        .set({
          status: "cashed_out",
          actualPayoutMicro: offer,
          settledAt: cashedOutAt,
        })
        .where(eq(tickets.id, ticketId));

      await tx
        .update(cashouts)
        .set({
          status: "accepted",
          payoutMicro: offer,
          acceptedAt: cashedOutAt,
          executedAt: cashedOutAt,
        })
        .where(eq(cashouts.id, quoteId));

      return { payoutMicro: offer, cashedOutAt };
    });

    // Best-effort WS push so the user's open-bets list flips immediately.
    try {
      await this.redis.publish(
        USER_CHANNEL_PREFIX + userId,
        JSON.stringify({
          type: "ticket",
          ticketId,
          status: "cashed_out",
          actualPayoutMicro: placed.payoutMicro.toString(),
        }),
      );
    } catch {
      // ignore
    }

    return placed;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async loadTicket(userId: string, ticketId: string) {
    const [t] = await this.db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.userId, userId)))
      .limit(1);
    if (!t) throw new NotFoundError("ticket_not_found", "ticket_not_found");
    return t;
  }

  private async loadLegs(ticketId: string) {
    return this.db
      .select({
        oddsAtPlacement: ticketSelections.oddsAtPlacement,
        result: ticketSelections.result,
        voidFactor: ticketSelections.voidFactor,
        marketId: ticketSelections.marketId,
        outcomeId: ticketSelections.outcomeId,
        marketStatus: markets.status,
        providerMarketId: markets.providerMarketId,
        publishedOdds: marketOutcomes.publishedOdds,
        probability: marketOutcomes.probability,
        active: marketOutcomes.active,
        sportId: categories.sportId,
        tournamentId: matches.tournamentId,
        matchScheduledAt: matches.scheduledAt,
        matchStatus: matches.status,
      })
      .from(ticketSelections)
      .innerJoin(markets, eq(markets.id, ticketSelections.marketId))
      .innerJoin(matches, eq(matches.id, markets.matchId))
      .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
      .innerJoin(categories, eq(categories.id, tournaments.categoryId))
      .innerJoin(sports, eq(sports.id, categories.sportId))
      .leftJoin(
        marketOutcomes,
        and(
          eq(marketOutcomes.marketId, ticketSelections.marketId),
          eq(marketOutcomes.outcomeId, ticketSelections.outcomeId),
        ),
      )
      .where(eq(ticketSelections.ticketId, ticketId));
  }

  /**
   * Resolve cashout_config across the supplied legs. Cascade per leg:
   * market_type → tournament → sport → global. Across legs we take the
   * most-restrictive value:
   *   - enabled                     = AND
   *   - prematchFullPaybackSeconds  = MIN
   *   - acceptanceDelaySeconds      = MAX (longer delay = more cautious
   *                                        for the bookmaker)
   *   - minOfferMicro               = MAX
   *   - minValueChangeBp            = MAX
   *   - deductionLadder             = first non-null leg's ladder
   */
  private async resolveConfig(
    legs: Array<{
      sportId: number;
      tournamentId: number;
      providerMarketId: number;
    }>,
  ): Promise<ResolvedConfig> {
    const allConfigs = await this.db.select().from(cashoutConfig);
    const byScope = new Map<string, (typeof allConfigs)[number]>();
    for (const c of allConfigs) {
      const key = `${c.scope}:${c.scopeRefId ?? ""}`;
      byScope.set(key, c);
    }
    const global = byScope.get("global:") ?? null;
    if (!global) {
      // No global row → fail closed.
      return {
        enabled: false,
        prematchFullPaybackSeconds: 0,
        deductionLadder: null,
        minOfferMicro: 0n,
        minValueChangeBp: 0,
        acceptanceDelaySeconds: 0,
      };
    }

    const perLeg: ResolvedConfig[] = legs.map((leg) => {
      const market = byScope.get(`market_type:${leg.providerMarketId}`);
      const tournament = byScope.get(`tournament:${leg.tournamentId}`);
      const sport = byScope.get(`sport:${leg.sportId}`);
      const winner = market ?? tournament ?? sport ?? global;
      const ladder = readLadder(winner.deductionLadderJson);
      return {
        enabled: winner.enabled,
        prematchFullPaybackSeconds: winner.prematchFullPaybackSeconds,
        deductionLadder: ladder,
        minOfferMicro: winner.minOfferMicro,
        minValueChangeBp: winner.minValueChangeBp,
        acceptanceDelaySeconds: winner.acceptanceDelaySeconds,
      };
    });

    return perLeg.reduce<ResolvedConfig>(
      (acc, c) => ({
        enabled: acc.enabled && c.enabled,
        prematchFullPaybackSeconds: Math.min(
          acc.prematchFullPaybackSeconds,
          c.prematchFullPaybackSeconds,
        ),
        deductionLadder: acc.deductionLadder ?? c.deductionLadder,
        minOfferMicro:
          c.minOfferMicro > acc.minOfferMicro ? c.minOfferMicro : acc.minOfferMicro,
        minValueChangeBp: Math.max(acc.minValueChangeBp, c.minValueChangeBp),
        acceptanceDelaySeconds: Math.max(
          acc.acceptanceDelaySeconds,
          c.acceptanceDelaySeconds,
        ),
      }),
      {
        enabled: true,
        prematchFullPaybackSeconds: Number.MAX_SAFE_INTEGER,
        deductionLadder: null,
        minOfferMicro: 0n,
        minValueChangeBp: 0,
        acceptanceDelaySeconds: 0,
      },
    );
  }
}

function readLadder(raw: unknown): CashoutLadderStep[] | null {
  if (!Array.isArray(raw)) return null;
  const parsed: CashoutLadderStep[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as { factor: unknown }).factor === "number" &&
      typeof (item as { deduction: unknown }).deduction === "number"
    ) {
      parsed.push({
        factor: (item as { factor: number }).factor,
        deduction: (item as { deduction: number }).deduction,
      });
    }
  }
  return parsed.length > 0 ? parsed : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
