// RiskZilla open-liability release helper.
//
// The engine bumps riskzilla_bank_state.open_liability_micro by a
// ticket's FULL potential payout when it is accepted (commitAccepted in
// engine.ts). That running counter is decremented again when the ticket
// leaves the open set. There are four exit paths:
//
//   settle / cancel / rollback  → services/settlement (Go),
//                                  UpdateRiskzillaBankOnSettle/Reverse
//   bet-delay rejection         → services/bet-delay (Go), RejectAndRefund
//   cashout accept              → here (cashout/service.ts)
//   admin manual void           → here (admin/tickets.ts)
//
// Settlement's release only runs for tickets that reach settlement —
// maybeSettleTicket gates on status='accepted', so a ticket that became
// terminal by cashout (status='cashed_out') or admin void
// (status='voided') is skipped forever. Without an explicit release on
// those two paths the counter leaks the ticket's full potential payout
// permanently (until an admin runs /admin/riskzilla/bank/recompute) —
// progressively understating free capacity and over-tightening the
// placement bank gate. This helper is the release for those two paths.

import { sql } from "drizzle-orm";
import type { DbClient } from "@oddzilla/db";

// Matches RISKZILLA_CURRENCY in engine.ts. OZ demo tickets never bump
// the counter at placement, so they must never decrement it either.
const RISKZILLA_CURRENCY = "USDC";

// `tx` is a Drizzle transaction handle (or the raw db client). Same
// shape engine.ts uses for its in-tx SQL.
type SqlRunner =
  | DbClient
  | Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/**
 * Release the open-liability a ticket reserved at placement. Call inside
 * the same transaction that flips an accepted USDC ticket to a terminal
 * state OUTSIDE the settlement path (cashout, admin void).
 *
 * GREATEST(0, …) mirrors settlement's UpdateRiskzillaBankOnSettle so the
 * counter can't underflow under replay or races. The caller must guard
 * the status transition against double-application (the cashouts row
 * lock; the status='accepted' WHERE + RETURNING check) so this runs
 * exactly once per ticket. `currency` is trimmed before comparison
 * because the column is CHAR(4) ("OZ  " is padded; "USDC" is not).
 */
export async function releaseOpenLiability(
  tx: SqlRunner,
  currency: string,
  potentialPayoutMicro: bigint,
): Promise<void> {
  if (currency.trim() !== RISKZILLA_CURRENCY) return;
  if (potentialPayoutMicro <= 0n) return;
  await tx.execute(sql`
    UPDATE riskzilla_bank_state
       SET open_liability_micro =
             GREATEST(0, open_liability_micro - ${potentialPayoutMicro.toString()}::bigint),
           updated_at = NOW()
     WHERE id = 'default'
  `);
}
