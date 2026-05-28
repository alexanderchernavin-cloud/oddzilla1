// Oz loyalty-point ledger primitive.
//
// Every Oz credit in the system flows through `creditOz`. Callers
// construct a deterministic `idempotencyKey` from the (reason, source)
// pair and rely on the UNIQUE constraint on `oz_ledger.idempotency_key`
// (migration 0076) to make replay safe. On collision the function
// returns `{ credited: false }` — never throws — so settlement retries
// and admin double-clicks both no-op cleanly.
//
// The ledger row + balance upsert run inside whichever transaction the
// caller passes. Mirroring the writeCommunityProjection convention so
// settlement-side hooks (Go-driven, when they land) and TS-side hooks
// (engagement-floor, admin endpoint) can both participate in the
// triggering transaction without a separate connection.

import { sql } from "drizzle-orm";
import type { DbClient } from "@oddzilla/db";

// Same structural type as writeCommunityProjection — accepts both the
// request-scoped client and a transaction handle.
export type OzLedgerExecutor = Pick<DbClient, "execute">;

export interface CreditOzInput {
  userId: string;
  delta: number;
  reason: string;
  sourceKind?: string | null;
  sourceId?: string | null;
  idempotencyKey: string;
  // For admin credits, the admin user id. NULL on system credits
  // (engagement-floor / win-bonus / future automated hooks).
  createdBy?: string | null;
}

export interface CreditOzResult {
  // false when the idempotency key already exists — the caller's
  // retry hit a row that was previously credited. Not an error.
  credited: boolean;
  // Current balance after the credit (or the pre-existing balance on
  // a dedup'd call). Read out of oz_balance_user in the same round
  // trip so callers don't need a follow-up SELECT.
  balanceAfter: number;
}

// One round-trip implementation. The CTE chain is:
//   1. ins  — INSERT … ON CONFLICT (idempotency_key) DO NOTHING
//             RETURNING delta. Empty on dedup hit.
//   2. bump — INSERT into oz_balance_user with delta on conflict
//             update balance += delta. Skipped when ins is empty
//             via the WHERE EXISTS gate.
//   3. SELECT current balance for the user.
//
// Doing it as one statement keeps the credit atomic against parallel
// credits to the same user: a second concurrent call sees the bumped
// balance, not a phantom pre-update read.
export async function creditOz(
  db: OzLedgerExecutor,
  input: CreditOzInput,
): Promise<CreditOzResult> {
  if (!Number.isInteger(input.delta) || input.delta <= 0) {
    // Defence-in-depth — the DB CHECK constraint also enforces this,
    // but catching at the API boundary surfaces the bug at the
    // caller's stack frame, not inside Postgres.
    throw new Error(`oz_credit_invalid_delta: ${input.delta}`);
  }

  const rows = await db.execute<{ credited: boolean; balance_after: number }>(sql`
WITH ins AS (
  INSERT INTO oz_ledger
    (user_id, delta, reason, source_kind, source_id, idempotency_key, created_by)
  VALUES
    (${input.userId}::uuid,
     ${input.delta}::bigint,
     ${input.reason}::text,
     ${input.sourceKind ?? null}::text,
     ${input.sourceId ?? null}::text,
     ${input.idempotencyKey}::text,
     ${input.createdBy ?? null}::uuid)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING delta
),
bump AS (
  INSERT INTO oz_balance_user (user_id, balance, updated_at)
  SELECT ${input.userId}::uuid, ins.delta, now()
    FROM ins
  ON CONFLICT (user_id) DO UPDATE
    SET balance    = oz_balance_user.balance + EXCLUDED.balance,
        updated_at = now()
  RETURNING balance
)
SELECT
  EXISTS (SELECT 1 FROM ins)                                AS "credited",
  COALESCE(
    (SELECT balance FROM bump),
    (SELECT balance FROM oz_balance_user WHERE user_id = ${input.userId}::uuid),
    0
  )::bigint                                                 AS "balance_after"
  `);

  const row = rows[0];
  if (!row) {
    // Shouldn't happen — the SELECT always returns one row — but
    // surface as an error rather than silently returning a stub.
    throw new Error("oz_credit_no_result");
  }
  return {
    credited: Boolean(row.credited),
    balanceAfter: Number(row.balance_after),
  };
}
