// Read-only account snapshot handed to the Gemma assistant so it can answer
// account-specific questions ("what's my balance", "why did my bet lose")
// WITHOUT inventing anything. The server computes + formats every figure and
// hydrates each ticket's legs (market, pick, odds, won/lost, match) by reusing
// the exact path the "My bets" page uses (BetsService.listForUser). Strictly
// read-only and scoped to the asking bettor. Deliberately omits all
// secrets/PII (addresses, tx hashes, IPs, password/refresh hashes,
// admin-approver ids, bet_meta).

import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { fromMicroMoney } from "@oddzilla/types";
import type {
  SupportAccountDepositFact,
  SupportAccountFacts,
  SupportAccountTicketFact,
  SupportAccountWalletFact,
  SupportAccountWithdrawalFact,
} from "@oddzilla/types";
import { depositIntents, wallets, withdrawals } from "@oddzilla/db";
import { BetsService } from "../../bets/service.js";

const TICKET_LIMIT = 10;
const DEPOSIT_LIMIT = 5;
const WITHDRAWAL_LIMIT = 5;

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
