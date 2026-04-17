// /wallet endpoints. Phase 7 adds deposit addresses (HD-derived) and the
// withdrawal request flow.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, desc, and, sql } from "drizzle-orm";
import {
  users,
  wallets,
  walletLedger,
  depositAddresses,
  deposits as depositsTable,
  withdrawals as withdrawalsTable,
} from "@oddzilla/db";
import { CONFIRMATIONS_REQUIRED } from "@oddzilla/types";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../lib/errors.js";
import {
  deriveAddressesForUser,
  derivationPath,
  userIndexFromUUID,
} from "../../lib/hdwallet.js";

const ledgerQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const NETWORKS = ["TRC20", "ERC20"] as const;

const withdrawalBody = z.object({
  network: z.enum(NETWORKS),
  toAddress: z.string().min(16).max(64),
  amountMicro: z.string().regex(/^\d+$/, "amount must be a positive integer string"),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function masterMnemonic(): string {
  const m = process.env.HD_MASTER_MNEMONIC;
  if (!m) {
    throw new Error(
      "HD_MASTER_MNEMONIC is not set. Cannot derive deposit addresses.",
    );
  }
  return m;
}

export default async function walletRoutes(app: FastifyInstance) {
  // ── Balance summary ──────────────────────────────────────────────────
  app.get("/wallet", async (request) => {
    const u = request.requireAuth();
    const [wallet] = await app.db
      .select()
      .from(wallets)
      .where(eq(wallets.userId, u.id))
      .limit(1);
    if (!wallet) throw new NotFoundError("wallet_not_found", "wallet_not_found");
    return {
      currency: wallet.currency,
      balanceMicro: wallet.balanceMicro.toString(),
      lockedMicro: wallet.lockedMicro.toString(),
      availableMicro: (wallet.balanceMicro - wallet.lockedMicro).toString(),
    };
  });

  app.get("/wallet/ledger", async (request) => {
    const u = request.requireAuth();
    const q = ledgerQuery.parse(request.query);
    const rows = await app.db
      .select()
      .from(walletLedger)
      .where(eq(walletLedger.userId, u.id))
      .orderBy(desc(walletLedger.createdAt))
      .limit(q.limit);
    return {
      entries: rows.map((r) => ({
        id: r.id.toString(),
        deltaMicro: r.deltaMicro.toString(),
        type: r.type,
        refType: r.refType,
        refId: r.refId,
        txHash: r.txHash,
        memo: r.memo,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  // ── Deposit addresses ────────────────────────────────────────────────
  // First-read derives both network addresses and upserts into DB.
  // Subsequent reads are cheap DB lookups.
  app.get("/wallet/deposit-addresses", async (request) => {
    const u = request.requireAuth();

    const existing = await app.db
      .select()
      .from(depositAddresses)
      .where(eq(depositAddresses.userId, u.id));

    const have = new Set(existing.map((r) => r.network));
    const missing = NETWORKS.filter((n) => !have.has(n));

    if (missing.length > 0) {
      const userIndex = userIndexFromUUID(u.id);
      const derived = deriveAddressesForUser(masterMnemonic(), userIndex);

      for (const network of missing) {
        await app.db
          .insert(depositAddresses)
          .values({
            userId: u.id,
            network,
            address: derived[network],
            derivationPath: derivationPath(network, userIndex),
          })
          .onConflictDoNothing({
            target: [depositAddresses.userId, depositAddresses.network],
          });
      }
    }

    // Re-read so the response is authoritative.
    const rows = await app.db
      .select({
        network: depositAddresses.network,
        address: depositAddresses.address,
      })
      .from(depositAddresses)
      .where(eq(depositAddresses.userId, u.id))
      .orderBy(depositAddresses.network);

    return { addresses: rows };
  });

  // ── Recent deposits ──────────────────────────────────────────────────
  app.get("/wallet/deposits", async (request) => {
    const u = request.requireAuth();
    const q = listQuery.parse(request.query);
    const rows = await app.db
      .select()
      .from(depositsTable)
      .where(eq(depositsTable.userId, u.id))
      .orderBy(desc(depositsTable.seenAt))
      .limit(q.limit);
    return {
      deposits: rows.map((r) => ({
        id: r.id,
        network: r.network,
        txHash: r.txHash,
        logIndex: r.logIndex,
        toAddress: r.toAddress,
        amountMicro: r.amountMicro.toString(),
        confirmations: r.confirmations,
        confirmationsRequired: CONFIRMATIONS_REQUIRED[r.network],
        status: r.status,
        blockNumber: r.blockNumber?.toString() ?? null,
        seenAt: r.seenAt.toISOString(),
        creditedAt: r.creditedAt?.toISOString() ?? null,
      })),
    };
  });

  // ── Withdrawal request ───────────────────────────────────────────────
  app.post("/wallet/withdrawals", async (request) => {
    const u = request.requireAuth();
    const body = withdrawalBody.parse(request.body);
    const amount = BigInt(body.amountMicro);
    if (amount <= 0n) {
      throw new BadRequestError("amount_must_be_positive", "amount_must_be_positive");
    }
    validateDestinationAddress(body.network, body.toAddress);

    const withdrawalId = await app.db.transaction(async (tx) => {
      // Block non-active users inside the txn — FOR UPDATE on the wallet
      // row serialises concurrent requests, and reading users in the
      // same txn gives us a consistent snapshot. Mirrors the status
      // check in bets/service.ts.
      const [account] = await tx
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, u.id))
        .limit(1);
      if (!account) throw new NotFoundError("user_not_found", "user_not_found");
      if (account.status !== "active") {
        throw new ForbiddenError("account_not_active", "account_not_active");
      }

      const [wallet] = await tx
        .select()
        .from(wallets)
        .where(eq(wallets.userId, u.id))
        .for("update")
        .limit(1);
      if (!wallet) throw new NotFoundError("wallet_not_found", "wallet_not_found");

      const available = wallet.balanceMicro - wallet.lockedMicro;
      if (amount > available) {
        throw new BadRequestError("insufficient_balance", "insufficient_balance");
      }

      // Defensive: reject withdrawing to one of our own deposit addresses —
      // would create a circular credit path and nothing good.
      const selfAddresses = await tx
        .select({ address: depositAddresses.address })
        .from(depositAddresses)
        .where(
          and(
            eq(depositAddresses.network, body.network),
            eq(depositAddresses.address, body.toAddress),
          ),
        );
      if (selfAddresses.length > 0) {
        throw new BadRequestError("to_address_is_internal", "to_address_is_internal");
      }

      // Lock the stake so it can't be double-spent while the withdrawal
      // is pending admin approval. When an admin rejects, we release.
      await tx
        .update(wallets)
        .set({
          lockedMicro: sql`${wallets.lockedMicro} + ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(wallets.userId, u.id));

      const [inserted] = await tx
        .insert(withdrawalsTable)
        .values({
          userId: u.id,
          network: body.network,
          toAddress: body.toAddress,
          amountMicro: amount,
          feeMicro: 0n,
          status: "requested",
        })
        .returning();
      if (!inserted) throw new Error("withdrawal insert returned no row");
      return inserted.id;
    });

    return { id: withdrawalId, status: "requested" };
  });

  // ── Withdrawal history (user-scoped) ─────────────────────────────────
  app.get("/wallet/withdrawals", async (request) => {
    const u = request.requireAuth();
    const q = listQuery.parse(request.query);
    const rows = await app.db
      .select()
      .from(withdrawalsTable)
      .where(eq(withdrawalsTable.userId, u.id))
      .orderBy(desc(withdrawalsTable.requestedAt))
      .limit(q.limit);
    return {
      withdrawals: rows.map((r) => ({
        id: r.id,
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

  // ── Cancel a still-requested withdrawal (user self-service) ──────────
  app.post("/wallet/withdrawals/:id/cancel", async (request) => {
    const u = request.requireAuth();
    const params = z.object({ id: z.string().uuid() }).parse(request.params);

    await app.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(withdrawalsTable)
        .where(eq(withdrawalsTable.id, params.id))
        .for("update")
        .limit(1);
      if (!row) throw new NotFoundError("withdrawal_not_found", "withdrawal_not_found");
      if (row.userId !== u.id) throw new ForbiddenError();
      if (row.status !== "requested") {
        throw new BadRequestError(
          `cannot_cancel_status_${row.status}`,
          `cannot_cancel_status_${row.status}`,
        );
      }

      await tx
        .update(withdrawalsTable)
        .set({ status: "cancelled" })
        .where(eq(withdrawalsTable.id, params.id));

      // Release the lock.
      await tx
        .update(wallets)
        .set({
          lockedMicro: sql`${wallets.lockedMicro} - ${row.amountMicro}`,
          updatedAt: new Date(),
        })
        .where(eq(wallets.userId, u.id));
    });

    return { ok: true };
  });
}

// Minimal sanity checks on destination addresses. Real validation
// (checksum verification) happens inside wallet-watcher when it signs.
function validateDestinationAddress(network: "TRC20" | "ERC20", address: string) {
  if (network === "ERC20") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new BadRequestError("invalid_erc20_address", "invalid_erc20_address");
    }
  } else {
    // Tron base58 T-prefixed, 34 chars typical.
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
      throw new BadRequestError("invalid_trc20_address", "invalid_trc20_address");
    }
  }
}
