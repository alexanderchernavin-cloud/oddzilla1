// /admin/riskzilla/bank — singleton bank state + ledger.
//
// GET state and the recent ledger are admin-only. PUT bank_limit is
// extra-gated to a single admin email (`q1qooo@gmail.com`) — the user
// who controls operator funding. Anyone else with admin role gets a
// distinct "bank_admin_only" 403.
//
// Recompute endpoint walks open tickets + the ledger to rebuild
// open_liability_micro and bank_limit_micro from first principles. If
// either drifts (a settlement-side write got swallowed, a reverse
// path missed) the recompute restores ground truth.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import {
  riskzillaBankState,
  riskzillaBankLedger,
  adminAuditLog,
  users,
} from "@oddzilla/db";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../../lib/errors.js";

// Hard-coded by user request. Lower-cased for case-insensitive compare;
// users.email is citext so the DB equality is case-insensitive too.
const BANK_ADMIN_EMAIL = "q1qooo@gmail.com";

interface BankStateDto {
  bankLimitMicro: string;
  openLiabilityMicro: string;
  // Composite breakdown: bettor wallet balances are claims against the
  // bank (withdrawable on demand), so the operator's free risk capital
  // is `bank_limit − user_balances − open_liability`. Surfaced here so
  // the bank page shows the full picture without a second round-trip.
  userBalancesMicro: string;
  freeCapacityMicro: string;
  updatedAt: string;
  updatedBy: string | null;
}

interface BankLedgerDto {
  id: string;
  deltaMicro: string;
  type: string;
  refType: string | null;
  refId: string | null;
  actorUserId: string | null;
  memo: string | null;
  createdAt: string;
}

const adjustBody = z.object({
  // Either set the bank limit to an absolute value, or apply a signed
  // delta. Mutually exclusive — exactly one must be present. Both are
  // bigint-shaped strings so the JSON wire format doesn't lose precision.
  setMicro: z
    .string()
    .regex(/^\d+$/)
    .optional(),
  deltaMicro: z
    .string()
    .regex(/^-?\d+$/)
    .optional(),
  memo: z.string().min(1).max(500),
});

async function loadOrSeed(app: FastifyInstance) {
  const [row] = await app.db
    .select()
    .from(riskzillaBankState)
    .where(eq(riskzillaBankState.id, "default"))
    .limit(1);
  if (row) return row;
  // Migration seeds the row, but defensive insert keeps a freshly-
  // restored DB / test environment from blowing up here.
  const [inserted] = await app.db
    .insert(riskzillaBankState)
    .values({ id: "default" })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [refetched] = await app.db
    .select()
    .from(riskzillaBankState)
    .where(eq(riskzillaBankState.id, "default"))
    .limit(1);
  if (!refetched) throw new Error("riskzilla_bank_state row missing");
  return refetched;
}

function rowToDto(
  row: typeof riskzillaBankState.$inferSelect,
  userBalancesMicro: bigint = 0n,
): BankStateDto {
  const free = row.bankLimitMicro - userBalancesMicro - row.openLiabilityMicro;
  return {
    bankLimitMicro: row.bankLimitMicro.toString(),
    openLiabilityMicro: row.openLiabilityMicro.toString(),
    userBalancesMicro: userBalancesMicro.toString(),
    freeCapacityMicro: free.toString(),
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

async function loadUserBalances(app: FastifyInstance): Promise<bigint> {
  const rows = (await app.db.execute(sql`
    SELECT COALESCE(SUM(balance_micro), 0)::text AS total
      FROM wallets
     WHERE currency = 'USDC'
  `)) as unknown as Array<{ total: string }>;
  return BigInt(rows[0]?.total ?? "0");
}

function ledgerRowToDto(
  row: typeof riskzillaBankLedger.$inferSelect,
): BankLedgerDto {
  return {
    id: row.id.toString(),
    deltaMicro: row.deltaMicro.toString(),
    type: row.type,
    refType: row.refType,
    refId: row.refId,
    actorUserId: row.actorUserId,
    memo: row.memo,
    createdAt: row.createdAt.toISOString(),
  };
}

async function requireBankAdmin(
  app: FastifyInstance,
  userId: string,
): Promise<void> {
  const [row] = await app.db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new ForbiddenError();
  if (row.email.toLowerCase() !== BANK_ADMIN_EMAIL) {
    throw new ForbiddenError("bank_admin_only", "bank_admin_only");
  }
}

export default async function riskzillaBankRoutes(app: FastifyInstance) {
  app.get("/admin/riskzilla/bank", async (request) => {
    request.requireRole("admin");
    const [row, userBalances] = await Promise.all([
      loadOrSeed(app),
      loadUserBalances(app),
    ]);
    return rowToDto(row, userBalances);
  });

  app.get("/admin/riskzilla/bank/ledger", async (request) => {
    request.requireRole("admin");
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        type: z
          .enum(["seed", "bet_loss", "bet_payout", "bet_refund", "manual_adjust"])
          .optional(),
      })
      .parse(request.query);

    const rows = q.type
      ? await app.db
          .select()
          .from(riskzillaBankLedger)
          .where(eq(riskzillaBankLedger.type, q.type))
          .orderBy(sql`${riskzillaBankLedger.createdAt} DESC`)
          .limit(q.limit)
      : await app.db
          .select()
          .from(riskzillaBankLedger)
          .orderBy(sql`${riskzillaBankLedger.createdAt} DESC`)
          .limit(q.limit);

    return { entries: rows.map(ledgerRowToDto) };
  });

  app.put("/admin/riskzilla/bank/limit", async (request) => {
    const admin = request.requireRole("admin");
    await requireBankAdmin(app, admin.id);
    const body = adjustBody.parse(request.body);
    if ((body.setMicro && body.deltaMicro) || (!body.setMicro && !body.deltaMicro)) {
      throw new BadRequestError(
        "set_or_delta_required",
        "set_or_delta_required",
      );
    }

    const [before, userBalances] = await Promise.all([
      loadOrSeed(app),
      loadUserBalances(app),
    ]);
    let nextLimit: bigint;
    let delta: bigint;
    if (body.setMicro !== undefined) {
      nextLimit = BigInt(body.setMicro);
      delta = nextLimit - before.bankLimitMicro;
    } else {
      delta = BigInt(body.deltaMicro!);
      nextLimit = before.bankLimitMicro + delta;
    }
    if (nextLimit < 0n) {
      throw new BadRequestError(
        "bank_limit_cannot_go_negative",
        "bank_limit_cannot_go_negative",
      );
    }

    const result = await app.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(riskzillaBankState)
        .set({
          bankLimitMicro: nextLimit,
          updatedBy: admin.id,
          updatedAt: new Date(),
        })
        .where(eq(riskzillaBankState.id, "default"))
        .returning();
      if (!updated) throw new Error("bank_state update returned no row");

      // Audit-grade ledger row. type='manual_adjust' to distinguish
      // from settlement-driven movements; refId is null because there's
      // no ticket attached.
      await tx.insert(riskzillaBankLedger).values({
        deltaMicro: delta,
        type: "manual_adjust",
        refType: "admin",
        refId: null,
        actorUserId: admin.id,
        memo: body.memo,
      });

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "riskzilla.bank.limit_update",
        targetType: "riskzilla_bank_state",
        targetId: "default",
        beforeJson: rowToDto(before, userBalances) as unknown as Record<string, unknown>,
        afterJson: rowToDto(updated, userBalances) as unknown as Record<string, unknown>,
        ipInet: request.ip ?? null,
      });

      return updated;
    });

    return rowToDto(result, userBalances);
  });

  // Rebuild open_liability_micro from open tickets in case the running
  // counter drifted. Bank-admin-only since it can mutate state non-
  // trivially. Doesn't touch bank_limit (that's reconstructed on
  // demand from the ledger via /admin/riskzilla/bank/ledger).
  app.post("/admin/riskzilla/bank/recompute", async (request) => {
    const admin = request.requireRole("admin");
    await requireBankAdmin(app, admin.id);

    const [before, userBalances] = await Promise.all([
      loadOrSeed(app),
      loadUserBalances(app),
    ]);

    const rows = (await app.db.execute(sql`
      SELECT COALESCE(SUM(t.potential_payout_micro), 0)::text AS total
        FROM tickets t
       WHERE t.status IN ('accepted', 'pending_delay')
         AND t.currency = 'USDC'
    `)) as unknown as Array<{ total: string }>;
    const next = BigInt(rows[0]?.total ?? "0");

    const result = await app.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(riskzillaBankState)
        .set({
          openLiabilityMicro: next,
          updatedBy: admin.id,
          updatedAt: new Date(),
        })
        .where(eq(riskzillaBankState.id, "default"))
        .returning();
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "riskzilla.bank.recompute",
        targetType: "riskzilla_bank_state",
        targetId: "default",
        beforeJson: rowToDto(before, userBalances) as unknown as Record<string, unknown>,
        afterJson: updated
          ? (rowToDto(updated, userBalances) as unknown as Record<string, unknown>)
          : null,
        ipInet: request.ip ?? null,
      });
      return updated;
    });
    if (!result) throw new NotFoundError();
    return rowToDto(result, userBalances);
  });
}
