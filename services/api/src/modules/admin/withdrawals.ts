// /admin/withdrawals endpoints.
//
// Lifecycle:
//   requested → approved → submitted → confirmed
//   requested → rejected
//   approved  → failed   (signer/external broadcast failure)
//
// Approve does NOT broadcast — the admin sends from an external wallet
// and pastes the tx hash via /mark-submitted. /mark-confirmed performs
// the actual debit and enforces 4-eyes (the confirmer must be a
// different admin from the approver).

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, desc, sql } from "drizzle-orm";
import {
  withdrawals as withdrawalsTable,
  wallets,
  walletLedger,
  adminAuditLog,
} from "@oddzilla/db";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../lib/errors.js";
import { requireBalanceEditAdmin } from "../../lib/balance-edit-gate.js";

const listQuery = z.object({
  status: z
    .enum(["requested", "approved", "submitted", "confirmed", "failed", "cancelled"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const approveBody = z.object({
  feeMicro: z.string().regex(/^\d+$/).default("0"),
  note: z.string().max(500).optional(),
});
const rejectBody = z.object({
  reason: z.string().min(3).max(500),
});

// ERC20 tx hashes are 32 bytes shown as 0x + 64 hex.
const ETH_TX_HASH = /^0x[0-9a-fA-F]{64}$/u;
function validateTxHash(txHash: string): void {
  if (!ETH_TX_HASH.test(txHash)) {
    throw new BadRequestError("invalid_tx_hash_format", "tx_hash must be 0x + 64 hex chars");
  }
}

const submittedBody = z.object({
  txHash: z.string().min(8).max(128),
});
const confirmedBody = z.object({
  txHash: z.string().min(8).max(128),
});
const failedBody = z.object({
  reason: z.string().min(3).max(500),
  txHash: z.string().min(8).max(128).optional(),
});

export default async function adminWithdrawalsRoutes(app: FastifyInstance) {
  app.get("/admin/withdrawals", async (request) => {
    request.requireRole("admin");
    const q = listQuery.parse(request.query);
    const rows = await app.db
      .select()
      .from(withdrawalsTable)
      .where(q.status ? eq(withdrawalsTable.status, q.status) : sql`TRUE`)
      .orderBy(desc(withdrawalsTable.requestedAt))
      .limit(q.limit);
    return {
      withdrawals: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        network: r.network,
        toAddress: r.toAddress,
        amountMicro: r.amountMicro.toString(),
        feeMicro: r.feeMicro.toString(),
        status: r.status,
        txHash: r.txHash,
        requestedAt: r.requestedAt.toISOString(),
        approvedAt: r.approvedAt?.toISOString() ?? null,
        submittedAt: r.submittedAt?.toISOString() ?? null,
        confirmedAt: r.confirmedAt?.toISOString() ?? null,
        failureReason: r.failureReason,
        approvedByUserId: r.approvedByUserId,
        submittedByUserId: r.submittedByUserId,
        confirmedByUserId: r.confirmedByUserId,
      })),
    };
  });

  app.post("/admin/withdrawals/:id/approve", async (request) => {
    const admin = request.requireRole("admin");
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = approveBody.parse(request.body);
    const feeMicro = BigInt(body.feeMicro);

    await app.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(withdrawalsTable)
        .where(eq(withdrawalsTable.id, params.id))
        .for("update")
        .limit(1);
      if (!row) throw new NotFoundError("withdrawal_not_found", "withdrawal_not_found");
      if (row.status !== "requested") {
        throw new BadRequestError(
          `cannot_approve_status_${row.status}`,
          `cannot_approve_status_${row.status}`,
        );
      }

      await tx
        .update(withdrawalsTable)
        .set({
          status: "approved",
          feeMicro,
          approvedAt: new Date(),
          approvedByUserId: admin.id,
        })
        .where(eq(withdrawalsTable.id, params.id));

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "withdrawal.approve",
        targetType: "withdrawal",
        targetId: params.id,
        beforeJson: { status: row.status },
        afterJson: {
          status: "approved",
          feeMicro: feeMicro.toString(),
          note: body.note ?? null,
        },
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true, status: "approved" };
  });

  app.post("/admin/withdrawals/:id/reject", async (request) => {
    const admin = request.requireRole("admin");
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = rejectBody.parse(request.body);

    await app.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(withdrawalsTable)
        .where(eq(withdrawalsTable.id, params.id))
        .for("update")
        .limit(1);
      if (!row) throw new NotFoundError("withdrawal_not_found", "withdrawal_not_found");
      if (row.status !== "requested") {
        throw new BadRequestError(
          `cannot_reject_status_${row.status}`,
          `cannot_reject_status_${row.status}`,
        );
      }

      await tx
        .update(wallets)
        .set({
          lockedMicro: sql`${wallets.lockedMicro} - ${row.amountMicro}`,
          updatedAt: new Date(),
        })
        .where(and(eq(wallets.userId, row.userId), eq(wallets.currency, "USDC")));

      await tx
        .insert(walletLedger)
        .values({
          userId: row.userId,
          currency: "USDC",
          deltaMicro: 0n,
          type: "adjustment",
          refType: "withdrawal_reject",
          refId: params.id,
          memo: body.reason,
        })
        .onConflictDoNothing();

      await tx
        .update(withdrawalsTable)
        .set({
          status: "failed",
          failureReason: body.reason,
        })
        .where(eq(withdrawalsTable.id, params.id));

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "withdrawal.reject",
        targetType: "withdrawal",
        targetId: params.id,
        beforeJson: { status: row.status },
        afterJson: { status: "failed", reason: body.reason },
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true, status: "failed" };
  });

  app.post("/admin/withdrawals/:id/mark-submitted", async (request) => {
    const admin = request.requireRole("admin");
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = submittedBody.parse(request.body);

    await app.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(withdrawalsTable)
        .where(eq(withdrawalsTable.id, params.id))
        .for("update")
        .limit(1);
      if (!row) throw new NotFoundError("withdrawal_not_found", "withdrawal_not_found");
      if (row.status !== "approved") {
        throw new BadRequestError(
          `cannot_submit_status_${row.status}`,
          `cannot_submit_status_${row.status}`,
        );
      }
      validateTxHash(body.txHash);
      const txHash = body.txHash.toLowerCase();

      await tx
        .update(withdrawalsTable)
        .set({
          status: "submitted",
          txHash,
          submittedAt: new Date(),
          submittedByUserId: admin.id,
        })
        .where(eq(withdrawalsTable.id, params.id));

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "withdrawal.mark-submitted",
        targetType: "withdrawal",
        targetId: params.id,
        beforeJson: { status: row.status },
        afterJson: { status: "submitted", txHash },
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true, status: "submitted" };
  });

  // mark-confirmed actually debits the balance; gate to the
  // balance-edit operator allowlist (see lib/balance-edit-gate.ts).
  // 4-eyes is preserved — the approver must still be a different
  // admin from the one who is on the allowlist.
  app.post("/admin/withdrawals/:id/mark-confirmed", async (request) => {
    const admin = await requireBalanceEditAdmin(app, request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = confirmedBody.parse(request.body);

    await app.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(withdrawalsTable)
        .where(eq(withdrawalsTable.id, params.id))
        .for("update")
        .limit(1);
      if (!row) throw new NotFoundError("withdrawal_not_found", "withdrawal_not_found");
      if (row.status !== "submitted") {
        throw new BadRequestError(
          `cannot_confirm_status_${row.status}`,
          `cannot_confirm_status_${row.status}`,
        );
      }
      validateTxHash(body.txHash);
      const txHash = body.txHash.toLowerCase();
      // 4-eyes: confirmer ≠ approver. Raises the bar from "one stolen
      // admin token" to two for the actual debit.
      if (row.approvedByUserId && row.approvedByUserId === admin.id) {
        throw new ForbiddenError("approver_cannot_confirm", "approver_cannot_confirm");
      }

      const amount = row.amountMicro;
      const fee = row.feeMicro;
      const debit = amount + fee;

      const [wallet] = await tx
        .select()
        .from(wallets)
        .where(and(eq(wallets.userId, row.userId), eq(wallets.currency, "USDC")))
        .for("update")
        .limit(1);
      if (!wallet) throw new NotFoundError("wallet_not_found", "wallet_not_found");
      if (wallet.balanceMicro < debit) {
        throw new BadRequestError(
          "insufficient_balance_for_debit",
          "insufficient_balance_for_debit",
        );
      }

      await tx
        .update(wallets)
        .set({
          lockedMicro: sql`${wallets.lockedMicro} - ${amount}`,
          balanceMicro: sql`${wallets.balanceMicro} - ${debit}`,
          updatedAt: new Date(),
        })
        .where(and(eq(wallets.userId, row.userId), eq(wallets.currency, "USDC")));

      await tx
        .insert(walletLedger)
        .values({
          userId: row.userId,
          currency: "USDC",
          deltaMicro: -debit,
          type: "withdrawal",
          refType: "withdrawal",
          refId: params.id,
          txHash,
          memo: null,
        })
        .onConflictDoNothing();

      await tx
        .update(withdrawalsTable)
        .set({
          status: "confirmed",
          confirmedAt: new Date(),
          txHash,
          confirmedByUserId: admin.id,
        })
        .where(eq(withdrawalsTable.id, params.id));

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "withdrawal.confirm",
        targetType: "withdrawal",
        targetId: params.id,
        beforeJson: { status: row.status },
        afterJson: { status: "confirmed", txHash },
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true, status: "confirmed" };
  });

  app.post("/admin/withdrawals/:id/mark-failed", async (request) => {
    const admin = request.requireRole("admin");
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = failedBody.parse(request.body);

    await app.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(withdrawalsTable)
        .where(eq(withdrawalsTable.id, params.id))
        .for("update")
        .limit(1);
      if (!row) throw new NotFoundError("withdrawal_not_found", "withdrawal_not_found");
      if (!(row.status === "approved" || row.status === "submitted")) {
        throw new BadRequestError(
          `cannot_fail_status_${row.status}`,
          `cannot_fail_status_${row.status}`,
        );
      }

      let failedTxHash: string | null = row.txHash;
      if (body.txHash) {
        validateTxHash(body.txHash);
        failedTxHash = body.txHash.toLowerCase();
      }

      await tx
        .update(wallets)
        .set({
          lockedMicro: sql`${wallets.lockedMicro} - ${row.amountMicro}`,
          updatedAt: new Date(),
        })
        .where(and(eq(wallets.userId, row.userId), eq(wallets.currency, "USDC")));

      await tx
        .insert(walletLedger)
        .values({
          userId: row.userId,
          currency: "USDC",
          deltaMicro: 0n,
          type: "adjustment",
          refType: "withdrawal_fail",
          refId: params.id,
          memo: body.reason,
        })
        .onConflictDoNothing();

      await tx
        .update(withdrawalsTable)
        .set({
          status: "failed",
          failureReason: body.reason,
          txHash: failedTxHash,
        })
        .where(eq(withdrawalsTable.id, params.id));

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "withdrawal.fail",
        targetType: "withdrawal",
        targetId: params.id,
        beforeJson: { status: row.status },
        afterJson: { status: "failed", reason: body.reason, txHash: failedTxHash },
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true, status: "failed" };
  });
}
