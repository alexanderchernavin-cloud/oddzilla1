// /wallet endpoints.
//
// Deposit attribution model:
//   • Every user is shown the SAME shared ERC20 receive address.
//   • Users register their sending wallet(s) via /wallet/addresses.
//   • The wallet-watcher polls Alchemy for `Transfer` logs to the
//     receive address, looks up `from` in user_wallet_addresses, and
//     auto-creates a `confirming` deposit_intent for the matched
//     user. Confirmations + credit happen on the next ticks.
//
// There is intentionally NO user-facing "paste your tx hash" route.
// On-chain Transfers are public — exposing a self-claim endpoint
// would let any attacker on Etherscan grab another user's tx hash
// and steal their deposit. Deposits from unlinked senders fall
// through to admin review at /admin/deposits/:id/credit-manual.
//
// Registering a sending address requires PROOF OF CONTROL: the user
// signs an EIP-191 challenge (GET /wallet/addresses/challenge) binding
// (userId, address, issuedAt), and POST /wallet/addresses verifies the
// signature recovers the claimed address before storing it. Without this
// proof, any bettor could register an address they don't own — e.g. a CEX
// hot wallet that every exchange withdrawal originates from — and have the
// wallet-watcher auto-credit those deposits to their account, a
// deposit-attribution theft primitive equivalent to the tx-hash one above.
// Known shared-custody hot wallets are additionally blocklisted.
//
// Withdrawals stay manual — the user opens a request and an admin
// processes it from /admin/withdrawals using an external signer.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, desc, and, inArray, sql } from "drizzle-orm";
import { getAddress, verifyMessage } from "ethers";
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
import { isUniqueViolation } from "../../lib/pg-errors.js";

// Parse the cashout memo emitted by cashout/service.ts. Format is
//   `cashout offer ${offerMicro} for stake ${stakeMicro}`
// Returns null when the shape doesn't match (older rows or unrelated
// memos) so the FE falls back to the bare delta display.
function parseCashoutMemo(
  memo: string | null,
): { kind: "cashout"; stakeMicro: string; offerMicro: string } | null {
  if (!memo) return null;
  const m = memo.match(/^cashout offer (\d+) for stake (\d+)$/);
  if (!m) return null;
  const offer = m[1];
  const stake = m[2];
  if (!offer || !stake) return null;
  return { kind: "cashout", stakeMicro: stake, offerMicro: offer };
}

const ledgerQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  currency: z.enum(SUPPORTED_CURRENCIES).optional(),
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const withdrawalBody = z.object({
  toAddress: z.string().min(16).max(64),
  amountMicro: z.string().regex(/^\d+$/, "amount must be a positive integer string"),
});

// Cap concurrent open (non-terminal) withdrawal requests per user. Stops a
// bettor (or a stolen session) from flooding the manual admin review queue
// and piling up stake locks with many requests. Checked inside the
// placement tx after the per-user wallet FOR UPDATE lock, so concurrent
// requests from the same user serialize and can't race past the cap.
const MAX_PENDING_WITHDRAWALS = 5;
const OPEN_WITHDRAWAL_STATUSES = ["requested", "approved", "submitted"] as const;

const linkedWalletBody = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/u, "address must be 0x + 40 hex chars"),
  label: z.string().max(60).optional(),
  // EIP-191 personal_sign signature (65 bytes) over the challenge message,
  // proving control of `address`. Required — see the header comment and
  // GET /wallet/addresses/challenge.
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/u, "signature must be 0x + 130 hex chars"),
  issuedAt: z.number().int().positive(),
});

// Challenge freshness. The signed message embeds issuedAt; we accept it
// within this window (plus a small clock-skew allowance) so a captured
// signature has a bounded replay lifetime. Stateless — no nonce store is
// needed because the message also binds the authenticated userId and the
// address, which together prevent cross-user and cross-address reuse.
const CHALLENGE_TTL_SECONDS = 600;
const CHALLENGE_SKEW_SECONDS = 60;

// Best-effort blocklist of known custodial / exchange hot wallets. A
// shared-custody address can never prove single-user ownership, and CEX
// withdrawals originate from these public addresses. Defense-in-depth —
// the signature proof is the primary control. Lowercased.
const CEX_HOTWALLET_BLOCKLIST = new Set<string>([
  "0x28c6c06298d514db089934071355e5743bf21d60", // Binance
  "0x21a31ee1afc51d94c2efccaa2092ad1028285549", // Binance
  "0xdfd5293d8e347dfe59e90efd55b2956a1343963d", // Binance
  "0x56eddb7aa87536c09ccc2793473599fd21a8b17f", // Binance
  "0x9696f59e4d72e237be84ffd425dcad154bf96976", // Binance
  "0x71660c4005ba85c37ccec55d0c4493e66fe775d3", // Coinbase
  "0x503828976d22510aad0201ac7ec88293211d23da", // Coinbase
  "0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740", // Coinbase
  "0x3cd751e6b0078be393132286c442345e5dc49699", // Coinbase
]);

// Canonical EIP-191 challenge. getAddress() yields a checksummed address so
// signer + verifier agree byte-for-byte. Built identically by the GET
// challenge endpoint and the POST verifier.
function depositVerificationMessage(
  userId: string,
  checksummedAddress: string,
  issuedAt: number,
): string {
  return [
    "Oddzilla deposit address verification.",
    "Signing proves you control this wallet and authorizes Oddzilla to",
    "credit deposits sent FROM it to your account.",
    `User: ${userId}`,
    `Address: ${checksummedAddress}`,
    `Issued: ${issuedAt}`,
  ].join("\n");
}

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
        // Cashout rows store `offer - stake` as their delta (e.g. -1.55
        // OZ) which is the *net change to the user's wallet wealth* but
        // reads as a loss in the ledger when the actual user action was
        // a refund of 23.45 OZ. We surface the constituent stake +
        // offer values so the FE can render "Stake 25 OZ → Refund 23.45
        // OZ" alongside the row. Parsing the existing memo avoids any
        // wallet_ledger schema change.
        detail:
          r.type === "cashout"
            ? parseCashoutMemo(r.memo)
            : null,
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
  app.post(
    "/wallet/withdrawals",
    {
      // Withdrawals enter a manual admin review queue and lock stake. Cap
      // the request rate per IP so a bettor (or a stolen session) can't
      // flood the queue / churn wallet locks. Pairs with the per-user
      // MAX_PENDING_WITHDRAWALS cap enforced inside the tx below.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request) => {
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

      // Cap open withdrawal requests per user (serialized by the wallet
      // FOR UPDATE above) so the manual admin queue can't be flooded.
      const [pending] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(withdrawalsTable)
        .where(
          and(
            eq(withdrawalsTable.userId, u.id),
            inArray(withdrawalsTable.status, [...OPEN_WITHDRAWAL_STATUSES]),
          ),
        );
      if ((pending?.n ?? 0) >= MAX_PENDING_WITHDRAWALS) {
        throw new BadRequestError(
          "too_many_pending_withdrawals",
          "too_many_pending_withdrawals",
        );
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

  // Challenge for proving control of a sending address. The client signs
  // the returned `message` with the wallet key (personal_sign) and submits
  // the signature to POST /wallet/addresses. Stateless — the server
  // re-derives and verifies the message on submit.
  app.get("/wallet/addresses/challenge", async (request) => {
    const u = request.requireAuth();
    const q = z
      .object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/u) })
      .parse(request.query);
    let checksummed: string;
    try {
      checksummed = getAddress(q.address);
    } catch {
      throw new BadRequestError("invalid_address", "invalid_address");
    }
    const issuedAt = Math.floor(Date.now() / 1000);
    return {
      issuedAt,
      ttlSeconds: CHALLENGE_TTL_SECONDS,
      message: depositVerificationMessage(u.id, checksummed, issuedAt),
    };
  });

  app.post(
    "/wallet/addresses",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
    const u = request.requireAuth();
    const body = linkedWalletBody.parse(request.body);

    let checksummed: string;
    try {
      checksummed = getAddress(body.address);
    } catch {
      throw new BadRequestError("invalid_address", "invalid_address");
    }
    const lower = checksummed.toLowerCase();

    // Reject the operator's own receive address — would create a cycle
    // where users could "credit" themselves with house-side refunds.
    if (receiveAddress && lower === receiveAddress.toLowerCase()) {
      throw new BadRequestError("address_is_internal", "address_is_internal");
    }

    // Reject known shared-custody / exchange hot wallets (defense-in-depth).
    if (CEX_HOTWALLET_BLOCKLIST.has(lower)) {
      throw new BadRequestError("address_not_allowed", "address_not_allowed");
    }

    // ── Proof of control (EIP-191) ───────────────────────────────────
    // The signed challenge binds (userId, address, issuedAt). A captured
    // signature can't be replayed by another user (the server rebuilds the
    // message with the AUTHENTICATED user's id, so verification recovers a
    // different address) nor reused for a different address (the address is
    // in the signed bytes). The freshness window bounds replay lifetime.
    const nowSec = Math.floor(Date.now() / 1000);
    if (
      body.issuedAt > nowSec + CHALLENGE_SKEW_SECONDS ||
      body.issuedAt < nowSec - CHALLENGE_TTL_SECONDS
    ) {
      throw new BadRequestError("challenge_expired", "challenge_expired");
    }
    const message = depositVerificationMessage(u.id, checksummed, body.issuedAt);
    let recovered: string;
    try {
      recovered = verifyMessage(message, body.signature);
    } catch {
      throw new BadRequestError("invalid_signature", "invalid_signature");
    }
    if (recovered.toLowerCase() !== lower) {
      throw new BadRequestError(
        "signature_address_mismatch",
        "signature_address_mismatch",
      );
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
      // Walks `.cause` so DrizzleQueryError unwrapping still
      // catches the SQLSTATE — the prior inline check only saw
      // direct `.code` and missed the wrapped form.
      if (isUniqueViolation(err)) {
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
