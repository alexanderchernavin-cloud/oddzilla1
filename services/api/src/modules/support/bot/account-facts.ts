// Read-only context handed to the Gemma assistant.
//
// buildAccountFacts: the asking bettor's own account (wallet, tickets with
// per-leg results, deposits, withdrawals) so it can answer account-specific
// questions WITHOUT inventing anything. Strictly read-only, scoped to the
// bettor, and omits all secrets/PII (addresses, tx hashes, IPs, hashes,
// admin-approver ids, bet_meta).
//
// buildCatalogDigest: the current bettable schedule (upcoming + live matches),
// shared across threads, so the assistant can answer "when does team X play",
// "what's live", "what's on" — catalog data, not account data.

import type { FastifyInstance } from "fastify";
import { desc, eq, sql } from "drizzle-orm";
import { fromMicroMoney } from "@oddzilla/types";
import type {
  SupportAccountDepositFact,
  SupportAccountFacts,
  SupportAccountTicketFact,
  SupportAccountWalletFact,
  SupportAccountWithdrawalFact,
  SupportCatalogMatch,
} from "@oddzilla/types";
import { depositIntents, wallets, withdrawals } from "@oddzilla/db";
import { BetsService } from "../../bets/service.js";

const TICKET_LIMIT = 10;
const DEPOSIT_LIMIT = 5;
const WITHDRAWAL_LIMIT = 5;
// All currently-bettable matches (upcoming + live). Small in practice (~tens),
// so the whole near-term schedule fits the model context once it's widened.
const CATALOG_LIMIT = 150;

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

// char(4) currency columns come back space-padded ("OZ  "); trim for display.
function cur(c: string): string {
  return c.trim();
}

export async function buildAccountFacts(
  app: FastifyInstance,
  userId: string,
): Promise<SupportAccountFacts> {
  // Reuse the same hydration the bet-history page uses so each leg carries a
  // human market name, the picked outcome, odds, won/lost result, and match.
  const bets = new BetsService(app.db, app.redis);
  const [walletRows, ticketSummaries, depositRows, withdrawalRows] =
    await Promise.all([
      app.db
        .select({
          currency: wallets.currency,
          balanceMicro: wallets.balanceMicro,
          lockedMicro: wallets.lockedMicro,
        })
        .from(wallets)
        .where(eq(wallets.userId, userId)),
      bets.listForUser(userId, TICKET_LIMIT),
      app.db
        .select({
          status: depositIntents.status,
          amountMicro: depositIntents.amountMicro,
          confirmations: depositIntents.confirmations,
          failureReason: depositIntents.failureReason,
          submittedAt: depositIntents.submittedAt,
        })
        .from(depositIntents)
        .where(eq(depositIntents.userId, userId))
        .orderBy(desc(depositIntents.submittedAt))
        .limit(DEPOSIT_LIMIT),
      app.db
        .select({
          status: withdrawals.status,
          amountMicro: withdrawals.amountMicro,
          feeMicro: withdrawals.feeMicro,
          failureReason: withdrawals.failureReason,
          requestedAt: withdrawals.requestedAt,
        })
        .from(withdrawals)
        .where(eq(withdrawals.userId, userId))
        .orderBy(desc(withdrawals.requestedAt))
        .limit(WITHDRAWAL_LIMIT),
    ]);

  const walletFacts: SupportAccountWalletFact[] = walletRows.map((w) => ({
    currency: cur(w.currency),
    available: fromMicroMoney(w.balanceMicro - w.lockedMicro, { decimals: 2 }),
    locked: fromMicroMoney(w.lockedMicro, { decimals: 2 }),
  }));

  const ticketFacts: SupportAccountTicketFact[] = ticketSummaries.map((t) => ({
    id: t.id,
    status: t.status,
    betType: t.betType,
    currency: cur(t.currency),
    stake: fromMicroMoney(BigInt(t.stakeMicro), { decimals: 2 }),
    potentialPayout: fromMicroMoney(BigInt(t.potentialPayoutMicro), {
      decimals: 2,
    }),
    actualPayout:
      t.actualPayoutMicro == null
        ? null
        : fromMicroMoney(BigInt(t.actualPayoutMicro), { decimals: 2 }),
    placedAt: t.placedAt,
    settledAt: t.settledAt,
    legs: t.selections.map((s) => ({
      market:
        s.market?.marketName ||
        (s.market ? `Market #${s.market.providerMarketId}` : "Unknown market"),
      pick: s.market?.outcomeName || s.outcomeId,
      odds: s.oddsAtPlacement,
      result: s.result ?? "pending",
      match: s.market ? `${s.market.homeTeam} vs ${s.market.awayTeam}` : "",
      sport: s.market?.sportSlug ?? "",
      matchStatus: s.market?.matchStatus ?? "",
    })),
  }));

  const depositFacts: SupportAccountDepositFact[] = depositRows.map((d) => ({
    status: d.status,
    amount:
      d.amountMicro == null
        ? null
        : fromMicroMoney(d.amountMicro, { decimals: 2 }),
    confirmations: d.confirmations,
    failureReason: d.failureReason ?? null,
    submittedAt: iso(d.submittedAt),
  }));

  const withdrawalFacts: SupportAccountWithdrawalFact[] = withdrawalRows.map(
    (w) => ({
      status: w.status,
      amount: fromMicroMoney(w.amountMicro, { decimals: 2 }),
      fee: fromMicroMoney(w.feeMicro, { decimals: 2 }),
      failureReason: w.failureReason ?? null,
      requestedAt: iso(w.requestedAt),
    }),
  );

  return {
    wallets: walletFacts,
    tickets: ticketFacts,
    deposits: depositFacts,
    withdrawals: withdrawalFacts,
  };
}

/** The current bettable schedule (upcoming + live matches with an active
 * market). Shared catalog data — same for every bettor — so the assistant can
 * answer schedule / "what's on" / "when does X play next" questions. */
export async function buildCatalogDigest(
  app: FastifyInstance,
): Promise<SupportCatalogMatch[]> {
  const rows = await app.db.execute<{
    sport: string;
    tournament: string;
    home: string | null;
    away: string | null;
    scheduled_at: string;
    status: string;
  }>(sql`
    SELECT s.slug AS sport, t.name AS tournament,
           hc.name AS home, ac.name AS away,
           to_char(m.scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS scheduled_at,
           m.status
    FROM matches m
    JOIN tournaments t ON t.id = m.tournament_id
    JOIN categories cat ON cat.id = t.category_id
    JOIN sports s ON s.id = cat.sport_id
    LEFT JOIN competitors hc ON hc.id = m.home_competitor_id
    LEFT JOIN competitors ac ON ac.id = m.away_competitor_id
    WHERE m.status IN ('not_started', 'live')
      AND EXISTS (
        SELECT 1 FROM markets mk WHERE mk.match_id = m.id AND mk.status = 1
      )
    ORDER BY m.scheduled_at
    LIMIT ${CATALOG_LIMIT}
  `);
  return Array.from(rows).map((r) => ({
    sport: r.sport,
    tournament: r.tournament,
    home: r.home ?? "TBD",
    away: r.away ?? "TBD",
    scheduledAt: r.scheduled_at,
    status: r.status,
  }));
}
