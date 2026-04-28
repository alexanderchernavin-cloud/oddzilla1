// Cashout service. Two operations:
//
//   quote(userId, ticketId)
//     Loads the ticket, walks the cashout_config cascade, computes the
//     current offer via the pure algorithm, and persists the result as
//     a `cashouts` row in `offered` status. Returns CashoutQuote.
//
//   accept(userId, ticketId, quoteId, expectedOfferMicro)
//     Atomically: re-fetches the offered cashout, validates it's still
//     fresh (not expired) and the on-screen amount matches, then
//     transitions the ticket to cashed_out and credits the wallet via a
//     ledger row keyed (type='cashout', ref_type='ticket', ref_id=ticket).
//     The unique partial index on wallet_ledger makes accept idempotent
//     against retries.

import { Redis } from "ioredis";
import { eq, and, sql, isNull, desc } from "drizzle-orm";
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
  users,
} from "@oddzilla/db";
import type {
  CashoutQuote,
  CashoutLadderStep,
  CashoutUnavailableReason,
} from "@oddzilla/types";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ForbiddenError,
} from "../../lib/errors.js";
import { compute } from "./algorithm.js";

// Quote validity: long enough for a user to read the offer and click,
// short enough that the offer doesn't drift out from under us. The
// significant-change gate already protects against tiny moves; a hard
// 10s ceiling keeps stale offers off the wire.
const QUOTE_TTL_SECONDS = 10;

const USER_CHANNEL_PREFIX = "user:";

type TxHandle = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

interface ScopeKey {
  scope: "global" | "sport" | "tournament" | "market_type";
  scopeRefId: string | null;
}

interface ResolvedConfig {
  enabled: boolean;
  prematchFullPaybackSeconds: number;
  deductionLadder: CashoutLadderStep[] | null;
  minOfferMicro: bigint;
  minValueChangeBp: number;
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
      return { available: false, reason: "not_open", ticketStakeMicro: ticket.stakeMicro.toString() };
    }

    const legs = await this.loadLegs(ticketId);
    if (legs.length === 0) {
      return { available: false, reason: "not_open", ticketStakeMicro: ticket.stakeMicro.toString() };
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
        // marketOutcomes is left-joined; missing row → inactive.
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
        result.deductionFactor !== null ? result.deductionFactor.toFixed(4) : undefined,
      fullPayback: result.fullPayback,
    };

    if (!result.available) {
      // Persist negative outcomes too (audit + ratelimiting / cooldown
      // tooling), but at status='unavailable' so they never accept.
      await this.db.insert(cashouts).values({
        ticketId,
        userId,
        status: "unavailable",
        offeredMicro: 0n,
        ticketOddsSnapshot: result.ticketOdds.toFixed(4),
        probabilitySnapshot: result.probability.toFixed(15),
        deductionFactorSnapshot:
          result.deductionFactor !== null ? result.deductionFactor.toFixed(4) : null,
        reason: result.reason ?? null,
        expiresAt: new Date(Date.now() + QUOTE_TTL_SECONDS * 1000),
      });
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
          result.deductionFactor !== null ? result.deductionFactor.toFixed(4) : null,
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
   * Accept a previously-issued quote. Atomic: ticket → cashed_out,
   * wallet credit, ledger row.
   */
  async accept(
    userId: string,
    ticketId: string,
    quoteId: string,
    expectedOfferMicro: bigint,
  ): Promise<{ payoutMicro: bigint; cashedOutAt: Date }> {
    const placed = await this.db.transaction(async (tx) => {
      // ── Load + lock the quote, ticket, wallet ──────────────────────
      const [quote] = await tx
        .select()
        .from(cashouts)
        .where(and(eq(cashouts.id, quoteId), eq(cashouts.ticketId, ticketId)))
        .for("update")
        .limit(1);
      if (!quote) throw new NotFoundError("quote_not_found", "quote_not_found");
      if (quote.userId !== userId) throw new ForbiddenError("quote_other_user", "quote_other_user");
      if (quote.status !== "offered") {
        throw new ConflictError(`quote_${quote.status}`, `quote_${quote.status}`);
      }
      if (quote.expiresAt.getTime() < Date.now()) {
        await tx
          .update(cashouts)
          .set({ status: "expired" })
          .where(eq(cashouts.id, quoteId));
        throw new ConflictError("quote_expired", "quote_expired");
      }
      if (quote.offeredMicro !== expectedOfferMicro) {
        throw new ConflictError("quote_amount_mismatch", "quote_amount_mismatch");
      }

      const [ticket] = await tx
        .select()
        .from(tickets)
        .where(and(eq(tickets.id, ticketId), eq(tickets.userId, userId)))
        .for("update")
        .limit(1);
      if (!ticket) throw new NotFoundError("ticket_not_found", "ticket_not_found");
      if (ticket.status !== "accepted") {
        throw new ConflictError(`ticket_${ticket.status}`, `ticket_${ticket.status}`);
      }

      // Wallets are keyed (user_id, currency) since migration 0014.
      // Lock the row matching the ticket's currency.
      const [wallet] = await tx
        .select()
        .from(wallets)
        .where(and(eq(wallets.userId, userId), eq(wallets.currency, ticket.currency)))
        .for("update")
        .limit(1);
      if (!wallet) throw new NotFoundError("wallet_not_found", "wallet_not_found");

      const cashedOutAt = new Date();
      const stake = ticket.stakeMicro;
      const offer = quote.offeredMicro;
      // Net delta to balance:
      //   At placement we did: locked += stake, balance unchanged
      //   On cashout we want : balance += offer - stake (the gain/loss),
      //                        locked -= stake (release stake hold).
      // Why: we never debited balance at placement; the stake was held
      // via locked_micro. The cashout payout is offer; if offer < stake
      // the user effectively loses (stake - offer) and balance decreases.

      await tx
        .update(wallets)
        .set({
          balanceMicro: sql`${wallets.balanceMicro} + ${offer} - ${stake}`,
          lockedMicro: sql`${wallets.lockedMicro} - ${stake}`,
          updatedAt: cashedOutAt,
        })
        .where(and(eq(wallets.userId, userId), eq(wallets.currency, ticket.currency)));

      // Apply-once ledger row. Unique partial index on (type, ref_type,
      // ref_id) means a retry of this whole tx is safe.
      await tx.insert(walletLedger).values({
        userId,
        currency: ticket.currency,
        deltaMicro: offer - stake,
        type: "cashout",
        refType: "ticket",
        refId: ticketId,
        memo: `cashout offer ${offer.toString()} for stake ${stake.toString()}`,
      });

      // Transition the ticket.
      await tx
        .update(tickets)
        .set({
          status: "cashed_out",
          actualPayoutMicro: offer,
          settledAt: cashedOutAt,
        })
        .where(eq(tickets.id, ticketId));

      // Settle the quote row.
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
   * Resolve cashout_config across the supplied legs. The cascade is
   * market_type → tournament → sport → global, applied per-leg; the
   * tightest scope wins. For settings that are scalars (enabled,
   * prematchFullPaybackSeconds, etc.) we take the most-restrictive
   * across legs:
   *   - enabled = AND across legs
   *   - prematchFullPaybackSeconds = MIN across legs
   *   - minOfferMicro = MAX across legs
   *   - minValueChangeBp = MAX across legs
   * deductionLadder is taken from the highest-priority leg (the first
   * leg's resolved config). This is a rare-edge-case path so the
   * conservative AND/MIN/MAX choices keep us safe.
   */
  private async resolveConfig(
    legs: Array<{ sportId: number; tournamentId: number; providerMarketId: number }>,
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
        minOfferMicro: c.minOfferMicro > acc.minOfferMicro ? c.minOfferMicro : acc.minOfferMicro,
        minValueChangeBp: Math.max(acc.minValueChangeBp, c.minValueChangeBp),
      }),
      {
        enabled: true,
        prematchFullPaybackSeconds: Number.MAX_SAFE_INTEGER,
        deductionLadder: null,
        minOfferMicro: 0n,
        minValueChangeBp: 0,
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
