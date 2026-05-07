// /admin/deposits endpoints — manual oversight of the user-submitted
// tx-hash deposit flow.
//
// The wallet-watcher Go service handles the happy path: poll
// deposit_intents, resolve receipt, credit on confirmations. Admins
// step in when:
//   • The watcher rejected an intent the operator wants to credit
//     anyway (e.g. unusual tx shape the parser doesn't handle).
//   • The watcher hasn't run for a while and the operator wants to
//     credit a known-good tx by hand.
//   • A pending intent should be terminally rejected (fake hash,
//     fraud, abandoned claim).
//
// Manual credit goes through the same atomic UPDATE+INSERT shape as
// the watcher so the wallet_ledger unique partial index keeps the
// double-credit guarantee.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import {
  depositIntents,
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
    .enum(["pending", "confirming", "credited", "rejected"])
    .optional(),
  userId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const creditBody = z.object({
  amountMicro: z.string().regex(/^\d+$/, "amount must be a positive integer string"),
  fromAddress: z.string().min(8).max(128).optional(),
  blockNumber: z.string().regex(/^\d+$/).optional(),
  blockHash: z.string().min(8).max(128).optional(),
  note: z.string().max(500).optional(),
});

const rejectBody = z.object({
  reason: z.string().min(3).max(500),
});

export default async function adminDepositsRoutes(app: FastifyInstance) {
  app.get("/admin/deposits", async (request) => {
    request.requireRole("admin");
    const q = listQuery.parse(request.query);

    const conditions = [];
    if (q.status) conditions.push(eq(depositIntents.status, q.status));
    if (q.userId) conditions.push(eq(depositIntents.userId, q.userId));

    const rows = await app.db
      .select()
      .from(depositIntents)
      .where(conditions.length ? sql.join(conditions, sql` AND `) : sql`TRUE`)
      .orderBy(desc(depositIntents.submittedAt))
      .limit(q.limit);

    return {
      deposits: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        network: r.network,
        txHash: r.txHash,
        fromAddress: r.fromAddress,
        toAddress: r.toAddress,
        amountMicro: r.amountMicro?.toString() ?? null,
        blockNumber: r.blockNumber?.toString() ?? null,
        blockHash: r.blockHash,
        logIndex: r.logIndex,
        confirmations: r.confirmations,
        status: r.status,
        failureReason: r.failureReason,
        submittedAt: r.submittedAt.toISOString(),
        creditedAt: r.creditedAt?.toISOString() ?? null,
        rejectedAt: r.rejectedAt?.toISOString() ?? null,
      })),
    };
  });

  // Manually credit a deposit_intent. Used when the watcher couldn't
  // auto-resolve it. The operator must enter the amount; everything
  // else (block number, from address) is optional metadata for audit.
  app.post("/admin/deposits/:id/credit-manual", async (request) => {
    const admin = request.requireRole("admin");
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = creditBody.parse(request.body);
    const amount = BigInt(body.amountMicro);
    if (amount <= 0n) {
      throw new BadRequestError("amount_must_be_positive", "amount_must_be_positive");
    }

    await app.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(depositIntents)
        .where(eq(depositIntents.id, params.id))
        .for("update")
        .limit(1);
      if (!row) throw new NotFoundError("deposit_intent_not_found", "deposit_intent_not_found");
      if (row.status === "credited") {
        throw new BadRequestError("already_credited", "already_credited");
      }

      const blockNumber = body.blockNumber ? BigInt(body.blockNumber) : row.blockNumber;
      await tx
        .update(depositIntents)
        .set({
          status: "credited",
          amountMicro: amount,
          fromAddress: body.fromAddress ?? row.fromAddress,
          blockNumber,
          blockHash: body.blockHash ?? row.blockHash,
          creditedAt: new Date(),
        })
        .where(eq(depositIntents.id, params.id));

      await tx
        .update(wallets)
        .set({
          balanceMicro: sql`${wallets.balanceMicro} + ${amount}`,
          updatedAt: new Date(),
        })
        .where(sql`${wallets.userId} = ${row.userId} AND ${wallets.currency} = 'USDC'`);

      // Apply-once via the unique partial index. A second manual
      // credit using the same intent id no-ops at the ledger row level
      // even if the row.status check above somehow let it through.
      await tx
        .insert(walletLedger)
        .values({
          userId: row.userId,
          currency: "USDC",
          deltaMicro: amount,
          type: "deposit",
          refType: "deposit_intent",
          refId: row.id,
          txHash: row.txHash,
          memo: body.note ?? "manual_credit",
        })
        .onConflictDoNothing();

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "deposit.credit-manual",
        targetType: "deposit_intent",
        targetId: row.id,
        beforeJson: { status: row.status, amountMicro: row.amountMicro?.toString() ?? null },
        afterJson: {
          status: "credited",
          amountMicro: amount.toString(),
          note: body.note ?? null,
          txHash: row.txHash,
        },
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true, status: "credited" };
  });

  app.post("/admin/deposits/:id/reject", async (request) => {
    const admin = request.requireRole("admin");
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = rejectBody.parse(request.body);

    await app.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(depositIntents)
        .where(eq(depositIntents.id, params.id))
        .for("update")
        .limit(1);
      if (!row) throw new NotFoundError("deposit_intent_not_found", "deposit_intent_not_found");
      if (row.status === "credited") {
        throw new BadRequestError("already_credited", "already_credited");
      }
      if (row.status === "rejected") {
        throw new BadRequestError("already_rejected", "already_rejected");
      }

      await tx
        .update(depositIntents)
        .set({
          status: "rejected",
          failureReason: body.reason,
          rejectedAt: new Date(),
        })
        .where(eq(depositIntents.id, params.id));

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "deposit.reject",
        targetType: "deposit_intent",
        targetId: row.id,
        beforeJson: { status: row.status },
        afterJson: { status: "rejected", reason: body.reason },
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true, status: "rejected" };
  });
}
