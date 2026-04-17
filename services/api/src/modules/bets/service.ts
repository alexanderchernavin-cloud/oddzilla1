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
} from "@oddzilla/db";
import {
  DEFAULT_ODDS_DRIFT_TOLERANCE,
  type PlaceBetRequest,
  type TicketSummary,
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
    if (req.selections.length > 1) {
      // MVP: singles only. Combo math + validation lands in a later phase.
      throw new BadRequestError("combos_not_yet_supported", "combos_not_yet_supported");
    }
    const stake = parseBigIntStrict(req.stakeMicro, "stakeMicro");
    if (stake <= 0n) {
      throw new BadRequestError("stake_must_be_positive", "stake_must_be_positive");
    }
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
        .where(eq(wallets.userId, ctx.userId))
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

      let productOdds = 1;
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
      }

      const potentialPayoutMicro = BigInt(
        Math.floor(Number(stake) * productOdds),
      );

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
          betType: "single",
          stakeMicro: stake,
          potentialPayoutMicro,
          idempotencyKey: req.idempotencyKey,
          notBeforeTs: notBefore,
          placedAt: now,
          acceptedAt,
          clientIp: ctx.ip,
          userAgent: ctx.userAgent,
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
      await tx.insert(ticketSelections).values(
        req.selections.map((s) => ({
          ticketId: inserted.id,
          marketId: BigInt(s.marketId),
          outcomeId: s.outcomeId,
          oddsAtPlacement: s.odds,
        })),
      );

      // ── Lock stake on wallet + audit ledger ──────────────────────────
      await tx
        .update(wallets)
        .set({
          lockedMicro: sql`${wallets.lockedMicro} + ${stake}`,
          updatedAt: new Date(),
        })
        .where(eq(wallets.userId, ctx.userId));

      await tx.insert(walletLedger).values({
        userId: ctx.userId,
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
    return {
      id: t.id,
      status: t.status,
      betType: t.betType,
      stakeMicro: t.stakeMicro.toString(),
      potentialPayoutMicro: t.potentialPayoutMicro.toString(),
      actualPayoutMicro:
        t.actualPayoutMicro !== null ? t.actualPayoutMicro.toString() : null,
      notBeforeTs: t.notBeforeTs?.toISOString() ?? null,
      rejectReason: t.rejectReason,
      placedAt: t.placedAt.toISOString(),
      acceptedAt: t.acceptedAt?.toISOString() ?? null,
      settledAt: t.settledAt?.toISOString() ?? null,
      selections: rows.map((r) => ({
        marketId: r.sel.marketId.toString(),
        outcomeId: r.sel.outcomeId,
        oddsAtPlacement: r.sel.oddsAtPlacement,
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
