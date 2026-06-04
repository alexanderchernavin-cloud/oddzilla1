// Read-only account snapshot handed to the Gemma assistant so it can answer
// "what's my balance / where's my withdrawal" WITHOUT inventing numbers — the
// server computes every figure and formats it as a decimal string. Strictly
// read-only and scoped to the asking bettor. Deliberately omits all
// secrets/PII: addresses, tx hashes, IPs, password/refresh hashes,
// admin-approver ids, bet_meta.

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
import { depositIntents, tickets, wallets, withdrawals } from "@oddzilla/db";

const TICKET_LIMIT = 5;
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
  const [walletRows, ticketRows, depositRows, withdrawalRows] = await Promise.all([
    app.db
      .select({
        currency: wallets.currency,
        balanceMicro: wallets.balanceMicro,
        lockedMicro: wallets.lockedMicro,
      })
      .from(wallets)
      .where(eq(wallets.userId, userId)),
    app.db
      .select({
        id: tickets.id,
        status: tickets.status,
        betType: tickets.betType,
        currency: tickets.currency,
        stakeMicro: tickets.stakeMicro,
        potentialPayoutMicro: tickets.potentialPayoutMicro,
        actualPayoutMicro: tickets.actualPayoutMicro,
        placedAt: tickets.placedAt,
        settledAt: tickets.settledAt,
      })
      .from(tickets)
      .where(eq(tickets.userId, userId))
      .orderBy(desc(tickets.placedAt))
      .limit(TICKET_LIMIT),
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

  const ticketFacts: SupportAccountTicketFact[] = ticketRows.map((t) => ({
    id: t.id,
    status: t.status,
    betType: t.betType,
    currency: cur(t.currency),
    stake: fromMicroMoney(t.stakeMicro, { decimals: 2 }),
    potentialPayout: fromMicroMoney(t.potentialPayoutMicro, { decimals: 2 }),
    actualPayout:
      t.actualPayoutMicro == null
        ? null
        : fromMicroMoney(t.actualPayoutMicro, { decimals: 2 }),
    placedAt: t.placedAt.toISOString(),
    settledAt: iso(t.settledAt),
  }));

  const depositFacts: SupportAccountDepositFact[] = depositRows.map((d) => ({
    status: d.status,
    amount:
      d.amountMicro == null ? null : fromMicroMoney(d.amountMicro, { decimals: 2 }),
    confirmations: d.confirmations,
    failureReason: d.failureReason ?? null,
    submittedAt: iso(d.submittedAt),
  }));

  const withdrawalFacts: SupportAccountWithdrawalFact[] = withdrawalRows.map((w) => ({
    status: w.status,
    amount: fromMicroMoney(w.amountMicro, { decimals: 2 }),
    fee: fromMicroMoney(w.feeMicro, { decimals: 2 }),
    failureReason: w.failureReason ?? null,
    requestedAt: iso(w.requestedAt),
  }));

  return {
    wallets: walletFacts,
    tickets: ticketFacts,
    deposits: depositFacts,
    withdrawals: withdrawalFacts,
  };
}
