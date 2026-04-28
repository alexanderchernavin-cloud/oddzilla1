// /admin/withdrawals endpoints.
//
// Lifecycle (per schema):
//   requested → approved → submitted → confirmed
//   requested → rejected
//   approved  → failed  (signer failure)
//
// Approve does NOT submit the tx — that's a signer's job (MVP: manual,
// Phase 7.5: dedicated signer container). The signer calls
// POST /admin/withdrawals/:id/mark-submitted with the tx_hash once the
// transaction is broadcast; wallet-watcher then picks up on-chain
// confirmations and flips to `confirmed`.

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
  NotFoundError,
} from "../../lib/errors.js";

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
      if (row.status !== "requested" && row.status !== "approved") {
        throw new BadRequestError(
          `cannot_reject_status_${row.status}`,
          `cannot_reject_status_${row.status}`,
        );
      }

      // Release the lock on the USDT wallet — withdrawals are USDT-only.
      await tx
        .update(wallets)
        .set({
          lockedMicro: sql`${wallets.lockedMicro} - ${row.amountMicro}`,
          updatedAt: new Date(),
        })
        .where(and(eq(wallets.userId, row.userId), eq(wallets.currency, "USDT")));

      await tx
        .update(withdrawalsTable)
        .set({
          status: "failed",
          failureReason: body.reason,
        })
        .where(eq(withdrawalsTable.id, params.id));

      // The audit log's action ('withdrawal.reject') preserves the
      // semantic distinction between an admin-initiated rejection and a
      // downstream signer failure even though both terminate as 'failed'
      // in the schema enum.
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

  // Signer reports the tx is broadcast.
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

      await tx
        .update(withdrawalsTable)
        .set({
          status: "submitted",
          txHash: body.txHash,
          submittedAt: new Date(),
        })
        .where(eq(withdrawalsTable.id, params.id));

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "withdrawal.mark-submitted",
        targetType: "withdrawal",
        targetId: params.id,
        beforeJson: { status: row.status },
        afterJson: { status: "submitted", txHash: body.txHash },
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true, status: "submitted" };
  });

  // Manual confirmation endpoint — wallet-watcher can also flip the row
  // once it sees the tx on chain. Keeping an admin override for cases
  // where the scanner is down or the tx needs to be force-confirmed.
  app.post("/admin/withdrawals/:id/mark-confirmed", async (request) => {
    const admin = request.requireRole("admin");
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

      // Debit the balance: release the lock AND subtract the amount.
      const amount = row.amountMicro;
      const fee = row.feeMicro;
      const debit = amount + fee;

      // Lock the wallet row and verify balance covers the debit before
      // applying the update. The wallets_balance_nonneg CHECK would reject
      // the update anyway, but that surfaces as a generic 500 — we'd
      // rather the admin UI see a clean 400 explaining the shortfall.
      const [wallet] = await tx
        .select()
        .from(wallets)
        .where(and(eq(wallets.userId, row.userId), eq(wallets.currency, "USDT")))
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
        .where(and(eq(wallets.userId, row.userId), eq(wallets.currency, "USDT")));

      await tx
        .insert(walletLedger)
        .values({
          userId: row.userId,
          currency: "USDT",
          deltaMicro: -debit,
          type: "withdrawal",
          refType: "withdrawal",
          refId: params.id,
          txHash: body.txHash,
          memo: null,
        })
        .onConflictDoNothing();

      await tx
        .update(withdrawalsTable)
        .set({
          status: "confirmed",
          confirmedAt: new Date(),
          txHash: body.txHash,
        })
        .where(eq(withdrawalsTable.id, params.id));

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "withdrawal.confirm",
        targetType: "withdrawal",
        targetId: params.id,
        beforeJson: { status: row.status },
        afterJson: { status: "confirmed", txHash: body.txHash },
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

      // Release the lock — user gets their funds back. USDT-only.
      await tx
        .update(wallets)
        .set({
          lockedMicro: sql`${wallets.lockedMicro} - ${row.amountMicro}`,
          updatedAt: new Date(),
        })
        .where(and(eq(wallets.userId, row.userId), eq(wallets.currency, "USDT")));

      await tx
        .update(withdrawalsTable)
        .set({
          status: "failed",
          failureReason: body.reason,
          txHash: body.txHash ?? row.txHash,
        })
        .where(eq(withdrawalsTable.id, params.id));

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "withdrawal.fail",
        targetType: "withdrawal",
        targetId: params.id,
        beforeJson: { status: row.status },
        afterJson: { status: "failed", reason: body.reason, txHash: body.txHash ?? null },
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true, status: "failed" };
  });
}
