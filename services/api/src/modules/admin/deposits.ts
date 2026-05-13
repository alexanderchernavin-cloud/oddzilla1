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
import { eq, desc, sql, and } from "drizzle-orm";
import {
  depositIntents,
  unattributedDeposits,
  wallets,
  walletLedger,
  adminAuditLog,
  users,
} from "@oddzilla/db";
import {
  BadRequestError,
  NotFoundError,
} from "../../lib/errors.js";
import { requireBalanceEditAdmin } from "../../lib/balance-edit-gate.js";
import { networkToCurrency } from "@oddzilla/types/networks";

// `wrong_token` is a sub-filter, not a column in deposit_intents.status.
// It maps to status='rejected' AND failure_reason='wrong_token'.
const listQuery = z.object({
  status: z
    .enum(["pending", "confirming", "credited", "rejected", "wrong_token"])
    .optional(),
  userId: z.string().uuid().optional(),
  acked: z.enum(["all", "unack", "ack"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const unattributedListQuery = z.object({
  acked: z.enum(["all", "unack", "ack"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const acknowledgeBody = z.object({
  // Operator note; persisted on the ack so the audit trail records
  // why this incident was considered handled.
  note: z.string().max(500).optional(),
  // When true, unsets acknowledged_at so an admin can re-open an alert
  // they acked by mistake.
  undo: z.boolean().optional(),
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
    if (q.status === "wrong_token") {
      conditions.push(
        sql`${depositIntents.status} = 'rejected'`,
        sql`${depositIntents.failureReason} = 'wrong_token'`,
      );
    } else if (q.status) {
      conditions.push(eq(depositIntents.status, q.status));
    }
    if (q.userId) conditions.push(eq(depositIntents.userId, q.userId));
    if (q.acked === "unack") {
      conditions.push(sql`${depositIntents.acknowledgedAt} IS NULL`);
    } else if (q.acked === "ack") {
      conditions.push(sql`${depositIntents.acknowledgedAt} IS NOT NULL`);
    }

    // Surface the bettor's email + display name on every row so the
    // operator can pick the right intent without decoding 8 hex chars
    // of UUID. Left-join not strictly needed (user_id is NOT NULL +
    // FK) but cheap insurance against a stale row.
    const rows = await app.db
      .select({
        intent: depositIntents,
        userEmail: users.email,
        userDisplayName: users.displayName,
      })
      .from(depositIntents)
      .leftJoin(users, eq(users.id, depositIntents.userId))
      .where(conditions.length ? sql.join(conditions, sql` AND `) : sql`TRUE`)
      .orderBy(desc(depositIntents.submittedAt))
      .limit(q.limit);

    return {
      deposits: rows.map(({ intent: r, userEmail, userDisplayName }) => ({
        id: r.id,
        userId: r.userId,
        userEmail,
        userDisplayName,
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
        detectedTokenContract: r.detectedTokenContract,
        detectedTokenAmountRaw: r.detectedTokenAmountRaw,
        acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
        submittedAt: r.submittedAt.toISOString(),
        creditedAt: r.creditedAt?.toISOString() ?? null,
        rejectedAt: r.rejectedAt?.toISOString() ?? null,
      })),
    };
  });

  // Alert counts for the admin sidebar badge. Tiny query against the
  // two partial indexes — cheap enough to poll on every admin page load.
  app.get("/admin/deposits/alert-counts", async (request) => {
    request.requireRole("admin");
    const rows = await app.db.execute<{
      wrongTokenUnack: string;
      unattributedUnack: string;
    }>(sql`
      SELECT
        (SELECT COUNT(*)::text FROM deposit_intents
          WHERE failure_reason = 'wrong_token' AND acknowledged_at IS NULL
        ) AS "wrongTokenUnack",
        (SELECT COUNT(*)::text FROM unattributed_deposits
          WHERE acknowledged_at IS NULL
        ) AS "unattributedUnack"
    `);
    const row = rows[0];
    const wt = Number(row?.wrongTokenUnack ?? 0);
    const ud = Number(row?.unattributedUnack ?? 0);
    return {
      wrongTokenUnack: wt,
      unattributedUnack: ud,
      total: wt + ud,
    };
  });

  // Wider eth_getLogs scan picks up any ERC20 Transfer to the receive
  // address from a contract other than USDC. List + acknowledge here.
  app.get("/admin/deposits/unattributed", async (request) => {
    request.requireRole("admin");
    const q = unattributedListQuery.parse(request.query);

    const conditions: ReturnType<typeof sql>[] = [];
    if (q.acked === "unack") {
      conditions.push(sql`${unattributedDeposits.acknowledgedAt} IS NULL`);
    } else if (q.acked === "ack") {
      conditions.push(sql`${unattributedDeposits.acknowledgedAt} IS NOT NULL`);
    }

    const rows = await app.db
      .select()
      .from(unattributedDeposits)
      .where(conditions.length ? sql.join(conditions, sql` AND `) : sql`TRUE`)
      .orderBy(desc(unattributedDeposits.detectedAt))
      .limit(q.limit);

    return {
      deposits: rows.map((r) => ({
        id: r.id,
        network: r.network,
        txHash: r.txHash,
        logIndex: r.logIndex,
        blockNumber: r.blockNumber.toString(),
        blockHash: r.blockHash,
        fromAddress: r.fromAddress,
        toAddress: r.toAddress,
        tokenContract: r.tokenContract,
        tokenSymbol: r.tokenSymbol,
        tokenDecimals: r.tokenDecimals,
        amountRaw: r.amountRaw,
        detectedAt: r.detectedAt.toISOString(),
        acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
        note: r.note,
      })),
    };
  });

  // Toggle the acknowledged stamp on a deposit_intents row. Only valid
  // for wrong_token failures (the alert surface) — credited / pending
  // rows have nothing to acknowledge.
  app.post("/admin/deposits/:id/acknowledge", async (request) => {
    const admin = request.requireRole("admin");
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = acknowledgeBody.parse(request.body ?? {});

    await app.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(depositIntents)
        .where(eq(depositIntents.id, params.id))
        .for("update")
        .limit(1);
      if (!row) {
        throw new NotFoundError("deposit_intent_not_found", "deposit_intent_not_found");
      }
      if (row.failureReason !== "wrong_token") {
        throw new BadRequestError(
          "not_a_wrong_token_alert",
          "not_a_wrong_token_alert",
        );
      }
      const isUndo = body.undo === true;
      if (!isUndo && row.acknowledgedAt) {
        throw new BadRequestError("already_acknowledged", "already_acknowledged");
      }
      if (isUndo && !row.acknowledgedAt) {
        throw new BadRequestError("not_acknowledged", "not_acknowledged");
      }

      await tx
        .update(depositIntents)
        .set({
          acknowledgedAt: isUndo ? null : new Date(),
          acknowledgedByUserId: isUndo ? null : admin.id,
        })
        .where(eq(depositIntents.id, params.id));

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: isUndo
          ? "deposit.wrong_token.unacknowledge"
          : "deposit.wrong_token.acknowledge",
        targetType: "deposit_intent",
        targetId: row.id,
        beforeJson: {
          acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
        },
        afterJson: {
          acknowledgedAt: isUndo ? null : new Date().toISOString(),
          note: body.note ?? null,
          detectedTokenContract: row.detectedTokenContract,
          detectedTokenAmountRaw: row.detectedTokenAmountRaw,
          txHash: row.txHash,
        },
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true };
  });

  app.post("/admin/deposits/unattributed/:id/acknowledge", async (request) => {
    const admin = request.requireRole("admin");
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = acknowledgeBody.parse(request.body ?? {});

    await app.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(unattributedDeposits)
        .where(eq(unattributedDeposits.id, params.id))
        .for("update")
        .limit(1);
      if (!row) {
        throw new NotFoundError(
          "unattributed_deposit_not_found",
          "unattributed_deposit_not_found",
        );
      }
      const isUndo = body.undo === true;
      if (!isUndo && row.acknowledgedAt) {
        throw new BadRequestError("already_acknowledged", "already_acknowledged");
      }
      if (isUndo && !row.acknowledgedAt) {
        throw new BadRequestError("not_acknowledged", "not_acknowledged");
      }

      // When acking with a note, append it to existing notes (pipe-
      // separated) so an auto-dedup mark from the watcher isn't lost.
      let nextNote = row.note;
      if (!isUndo && body.note) {
        nextNote = row.note ? `${row.note} | ${body.note}` : body.note;
      }

      await tx
        .update(unattributedDeposits)
        .set({
          acknowledgedAt: isUndo ? null : new Date(),
          acknowledgedByUserId: isUndo ? null : admin.id,
          note: nextNote,
        })
        .where(eq(unattributedDeposits.id, params.id));

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: isUndo
          ? "deposit.unattributed.unacknowledge"
          : "deposit.unattributed.acknowledge",
        targetType: "unattributed_deposit",
        targetId: row.id,
        beforeJson: {
          acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
          note: row.note,
        },
        afterJson: {
          acknowledgedAt: isUndo ? null : new Date().toISOString(),
          note: nextNote,
          tokenContract: row.tokenContract,
          amountRaw: row.amountRaw,
          txHash: row.txHash,
        },
        ipInet: request.ip ?? null,
      });
    });

    return { ok: true };
  });

  // Manually credit a deposit_intent. Used when the watcher couldn't
  // auto-resolve it. The operator must enter the amount; everything
  // else (block number, from address) is optional metadata for audit.
  // Restricted to the balance-edit operator allowlist — see
  // lib/balance-edit-gate.ts.
  app.post("/admin/deposits/:id/credit-manual", async (request) => {
    const admin = await requireBalanceEditAdmin(app, request);
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

      const currency = networkToCurrency(row.network);
      if (!currency) {
        throw new BadRequestError(
          "unsupported_deposit_network",
          `unsupported_deposit_network:${row.network}`,
        );
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
        .where(sql`${wallets.userId} = ${row.userId} AND ${wallets.currency} = ${currency}`);

      // Apply-once via the unique partial index. A second manual
      // credit using the same intent id no-ops at the ledger row level
      // even if the row.status check above somehow let it through.
      await tx
        .insert(walletLedger)
        .values({
          userId: row.userId,
          currency,
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
