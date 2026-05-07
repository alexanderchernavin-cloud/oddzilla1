// /wallet endpoints.
//
// Post-0032 the deposit flow is intent-based: every user is shown the
// same shared ERC20 receive address (configured via env), and after
// sending USDC they paste the tx hash here. The wallet-watcher Go
// service polls deposit_intents, validates the on-chain Transfer,
// counts confirmations, and credits the wallet atomically.
//
// Withdrawals stay manual — the user opens a request and an admin
// processes it from /admin/withdrawals using an external signer.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, desc, and, sql } from "drizzle-orm";
import { getAddress } from "ethers";
import {
  users,
  wallets,
  walletLedger,
  depositIntents,
  userWalletAddresses,
  withdrawals as withdrawalsTable,
} from "@oddzilla/db";
import { CONFIRMATIONS_REQUIRED, SUPPORTED_CURRENCIES } from "@oddzilla/types";
import { loadEnv } from "@oddzilla/config";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../lib/errors.js";

const ledgerQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  currency: z.enum(SUPPORTED_CURRENCIES).optional(),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ERC20 tx hash: 0x + 32 bytes of hex.
const ETH_TX_HASH = /^0x[0-9a-fA-F]{64}$/u;

const intentBody = z.object({
  txHash: z.string().regex(ETH_TX_HASH, "tx_hash must be 0x + 64 hex chars"),
});

const withdrawalBody = z.object({
  toAddress: z.string().min(16).max(64),
  amountMicro: z.string().regex(/^\d+$/, "amount must be a positive integer string"),
});

const linkedWalletBody = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/u, "address must be 0x + 40 hex chars"),
  label: z.string().max(60).optional(),
});

export default async function walletRoutes(app: FastifyInstance) {
  const env = loadEnv();
  const receiveAddress = env.DEPOSIT_RECEIVE_ADDRESS ?? null;

  // ── Balance summary ──────────────────────────────────────────────────
  app.get("/wallet", async (request) => {
    const u = request.requireAuth();
    const rows = await app.db
      .select()
      .from(wallets)
      .where(eq(wallets.userId, u.id));
    if (rows.length === 0) {
      throw new NotFoundError("wallet_not_found", "wallet_not_found");
    }
    const byCurrency = new Map(rows.map((r) => [r.currency.trim(), r]));
    const ordered = SUPPORTED_CURRENCIES
      .map((c) => byCurrency.get(c))
      .filter((r): r is NonNullable<typeof r> => r !== undefined);
    return {
      wallets: ordered.map((w) => ({
        currency: w.currency.trim(),
        balanceMicro: w.balanceMicro.toString(),
        lockedMicro: w.lockedMicro.toString(),
        availableMicro: (w.balanceMicro - w.lockedMicro).toString(),
      })),
    };
  });

  app.get("/wallet/ledger", async (request) => {
    const u = request.requireAuth();
    const q = ledgerQuery.parse(request.query);
    const conditions = [eq(walletLedger.userId, u.id)];
    if (q.currency) {
      conditions.push(eq(walletLedger.currency, q.currency));
    }
    const rows = await app.db
      .select()
      .from(walletLedger)
      .where(and(...conditions))
      .orderBy(desc(walletLedger.createdAt))
      .limit(q.limit);
    return {
      entries: rows.map((r) => ({
        id: r.id.toString(),
        currency: r.currency.trim(),
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

  // ── Shared deposit address ───────────────────────────────────────────
  // Single address served to everyone. The actual receive address is
  // operator-managed; we return null when env isn't configured so the
  // UI can surface "deposits temporarily unavailable" instead of a
  // half-rendered card.
  app.get("/wallet/deposit-address", async (request) => {
    request.requireAuth();
    if (!receiveAddress) {
      return { available: false, address: null };
    }
    return {
      available: true,
      address: {
        network: "ERC20" as const,
        address: receiveAddress,
        currency: "USDC" as const,
      },
    };
  });

  // ── Submit a tx-hash claim ───────────────────────────────────────────
  app.post("/wallet/deposits/intent", async (request) => {
    const u = request.requireAuth();
    const body = intentBody.parse(request.body);

    if (!receiveAddress) {
      throw new BadRequestError(
        "deposits_unavailable",
        "deposits_unavailable",
      );
    }

    const txHash = body.txHash.toLowerCase();

    // Block non-active users from claiming deposits — same gate we
    // apply to withdrawal requests.
    const [account] = await app.db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, u.id))
      .limit(1);
    if (!account) throw new NotFoundError("user_not_found", "user_not_found");
    if (account.status !== "active") {
      throw new ForbiddenError("account_not_active", "account_not_active");
    }

    try {
      const [inserted] = await app.db
        .insert(depositIntents)
        .values({
          userId: u.id,
          network: "ERC20",
          txHash,
          status: "pending",
        })
        .returning({
          id: depositIntents.id,
          status: depositIntents.status,
        });
      if (!inserted) throw new Error("intent insert returned no row");
      return { id: inserted.id, status: inserted.status };
    } catch (err) {
      // Postgres error code for unique_violation is "23505". We surface
      // a 409 so the UI can tell the user "that tx hash is already
      // recorded" without leaking whose intent it is.
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: string }).code === "23505"
      ) {
        throw new ConflictError(
          "tx_hash_already_claimed",
          "tx_hash_already_claimed",
        );
      }
      throw err;
    }
  });

  // ── Recent deposit intents ───────────────────────────────────────────
  app.get("/wallet/deposits", async (request) => {
    const u = request.requireAuth();
    const q = listQuery.parse(request.query);
    const rows = await app.db
      .select()
      .from(depositIntents)
      .where(eq(depositIntents.userId, u.id))
      .orderBy(desc(depositIntents.submittedAt))
      .limit(q.limit);
    return {
      deposits: rows.map((r) => ({
        id: r.id,
        network: r.network as "ERC20",
        txHash: r.txHash,
        fromAddress: r.fromAddress,
        toAddress: r.toAddress,
        amountMicro: r.amountMicro?.toString() ?? null,
        blockNumber: r.blockNumber?.toString() ?? null,
        confirmations: r.confirmations,
        confirmationsRequired: CONFIRMATIONS_REQUIRED.ERC20,
        status: r.status,
        failureReason: r.failureReason,
        submittedAt: r.submittedAt.toISOString(),
        creditedAt: r.creditedAt?.toISOString() ?? null,
        rejectedAt: r.rejectedAt?.toISOString() ?? null,
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
    const toAddress = validateErc20Address(body.toAddress);

    const withdrawalId = await app.db.transaction(async (tx) => {
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
        .where(and(eq(wallets.userId, u.id), eq(wallets.currency, "USDC")))
        .for("update")
        .limit(1);
      if (!wallet) throw new NotFoundError("wallet_not_found", "wallet_not_found");

      const available = wallet.balanceMicro - wallet.lockedMicro;
      if (amount > available) {
        throw new BadRequestError("insufficient_balance", "insufficient_balance");
      }

      // Defensive: reject withdrawing to the shared receive address —
      // that's our hot wallet, not a user destination.
      if (
        receiveAddress &&
        toAddress.toLowerCase() === receiveAddress.toLowerCase()
      ) {
        throw new BadRequestError("to_address_is_internal", "to_address_is_internal");
      }

      // Lock the stake until admin processes.
      await tx
        .update(wallets)
        .set({
          lockedMicro: sql`${wallets.lockedMicro} + ${amount}`,
          updatedAt: new Date(),
        })
        .where(and(eq(wallets.userId, u.id), eq(wallets.currency, "USDC")));

      const [inserted] = await tx
        .insert(withdrawalsTable)
        .values({
          userId: u.id,
          network: "ERC20",
          toAddress,
          amountMicro: amount,
          feeMicro: 0n,
          status: "requested",
        })
        .returning();
      if (!inserted) throw new Error("withdrawal insert returned no row");

      // Audit ledger row paired to the request. delta_micro = 0 — no
      // money moves, the lock is just a reservation. Apply-once via the
      // unique partial index.
      await tx
        .insert(walletLedger)
        .values({
          userId: u.id,
          currency: "USDC",
          deltaMicro: 0n,
          type: "adjustment",
          refType: "withdrawal_request",
          refId: inserted.id,
          memo: `withdrawal requested ${amount.toString()} ERC20`,
        })
        .onConflictDoNothing();

      return inserted.id;
    });

    return { id: withdrawalId, status: "requested" };
  });

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
        network: r.network as "ERC20",
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

  // ── Linked sending wallets (per-user from-address whitelist) ────────
  // Deposits arriving from a registered address are auto-attributed
  // to the user by the wallet-watcher. The tx-hash paste form remains
  // a fallback for unregistered senders.
  app.get("/wallet/addresses", async (request) => {
    const u = request.requireAuth();
    const rows = await app.db
      .select({
        id: userWalletAddresses.id,
        network: userWalletAddresses.network,
        address: userWalletAddresses.address,
        label: userWalletAddresses.label,
        createdAt: userWalletAddresses.createdAt,
      })
      .from(userWalletAddresses)
      .where(eq(userWalletAddresses.userId, u.id))
      .orderBy(desc(userWalletAddresses.createdAt));
    return {
      addresses: rows.map((r) => ({
        id: r.id,
        network: r.network as "ERC20",
        address: r.address,
        label: r.label,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  app.post("/wallet/addresses", async (request) => {
    const u = request.requireAuth();
    const body = linkedWalletBody.parse(request.body);
    const lower = body.address.toLowerCase();

    // Reject the operator's own receive address — would create a
    // cycle where users could "credit" themselves with house-side
    // refunds.
    if (receiveAddress && lower === receiveAddress.toLowerCase()) {
      throw new BadRequestError("address_is_internal", "address_is_internal");
    }

    try {
      const [inserted] = await app.db
        .insert(userWalletAddresses)
        .values({
          userId: u.id,
          network: "ERC20",
          address: lower,
          label: body.label ?? null,
        })
        .returning();
      if (!inserted) throw new Error("address insert returned no row");
      return {
        id: inserted.id,
        network: inserted.network as "ERC20",
        address: inserted.address,
        label: inserted.label,
        createdAt: inserted.createdAt.toISOString(),
      };
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: string }).code === "23505"
      ) {
        throw new ConflictError(
          "address_already_linked",
          "address_already_linked",
        );
      }
      throw err;
    }
  });

  app.delete("/wallet/addresses/:id", async (request) => {
    const u = request.requireAuth();
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await app.db
      .delete(userWalletAddresses)
      .where(
        and(
          eq(userWalletAddresses.id, params.id),
          eq(userWalletAddresses.userId, u.id),
        ),
      )
      .returning({ id: userWalletAddresses.id });
    if (result.length === 0) {
      throw new NotFoundError("address_not_found", "address_not_found");
    }
    return { ok: true };
  });

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

      await tx
        .update(wallets)
        .set({
          lockedMicro: sql`${wallets.lockedMicro} - ${row.amountMicro}`,
          updatedAt: new Date(),
        })
        .where(and(eq(wallets.userId, u.id), eq(wallets.currency, "USDC")));

      await tx
        .insert(walletLedger)
        .values({
          userId: u.id,
          currency: "USDC",
          deltaMicro: 0n,
          type: "adjustment",
          refType: "withdrawal_cancel",
          refId: params.id,
          memo: "user_cancelled",
        })
        .onConflictDoNothing();
    });

    return { ok: true };
  });
}

// Validate the destination is a well-formed ERC20 address. Accepts
// all-lower / all-upper (no checksum claim) and properly-checksummed
// EIP-55. Rejects mixed-case strings whose checksum doesn't match —
// almost certainly a typo'd paste.
function validateErc20Address(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(address)) {
    throw new BadRequestError("invalid_erc20_address", "invalid_erc20_address");
  }
  let canonical: string;
  try {
    canonical = getAddress(address);
  } catch {
    throw new BadRequestError("invalid_erc20_address", "invalid_erc20_address");
  }
  const isAllLower = address === address.toLowerCase();
  const isAllUpper = address === address.toUpperCase();
  if (!isAllLower && !isAllUpper && address !== canonical) {
    throw new BadRequestError("invalid_erc20_address", "invalid_erc20_address");
  }
  return canonical;
}
