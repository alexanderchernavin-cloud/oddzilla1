// /admin/tickets endpoints. Currently just manual void (cancel + refund).
//
// Manual void transitions an accepted ticket to `voided` and issues a
// full refund to the user's wallet. Single transaction; audit-logged.
// Idempotent via the wallet_ledger unique partial index — replaying the
// same admin action on the same ticket is a no-op ledger-wise.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import {
  tickets,
  wallets,
  walletLedger,
  adminAuditLog,
} from "@oddzilla/db";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../lib/errors.js";

const voidBody = z.object({
  reason: z.string().min(3).max(500),
});

const USER_CHANNEL_PREFIX = "user:";

export default async function adminTicketsRoutes(app: FastifyInstance) {
  // Compact list for the admin UI — all recent tickets, not just one
  // user's. Useful for incident triage.
  app.get("/admin/tickets", async (request) => {
    request.requireRole("admin");
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        status: z.enum(["pending_delay", "accepted", "rejected", "settled", "voided"]).optional(),
      })
      .parse(request.query);

    const rows = await app.db
      .select()
      .from(tickets)
      .where(q.status ? eq(tickets.status, q.status) : sql`TRUE`)
      .orderBy(sql`${tickets.placedAt} DESC`)
      .limit(q.limit);

    return {
      tickets: rows.map((t) => ({
        id: t.id,
        userId: t.userId,
        status: t.status,
        currency: t.currency.trim(),
        stakeMicro: t.stakeMicro.toString(),
        potentialPayoutMicro: t.potentialPayoutMicro.toString(),
        actualPayoutMicro: t.actualPayoutMicro?.toString() ?? null,
        placedAt: t.placedAt.toISOString(),
        settledAt: t.settledAt?.toISOString() ?? null,
        rejectReason: t.rejectReason,
      })),
    };
  });

  app.post("/admin/tickets/:id/void", async (request) => {
    const admin = request.requireRole("admin");
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = voidBody.parse(request.body);

    // Read ticket + status check + status-guarded UPDATE all happen
    // inside ONE transaction with FOR UPDATE on the row, so settlement
    // can't slip a payout in between our read and our write. Without
    // this, an admin clicking Void on an actively-settling ticket can
    // corrupt locked_micro (negative locked → inflated available) and
    // double-credit the ledger (bet_payout from settlement + bet_refund
    // from the void are distinct rows under the unique partial index).
    const userIdForPublish = await app.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(tickets)
        .where(eq(tickets.id, params.id))
        .for("update")
        .limit(1);
      if (!existing) throw new NotFoundError("ticket_not_found", "ticket_not_found");

      // Only `accepted` tickets can be manually voided. Settled tickets go
      // through rollback (handled by the settlement worker); rejected +
      // pending_delay are already out of the live set.
      if (existing.status !== "accepted") {
        throw new BadRequestError(
          `cannot_void_status_${existing.status}`,
          `cannot_void_status_${existing.status}`,
        );
      }

      const stakeMicro = existing.stakeMicro;
      const ticketCurrency = existing.currency;

      // Flip to voided with a full refund. Status guard on the WHERE is
      // redundant given FOR UPDATE above, but cheap defense-in-depth —
      // RETURNING.length catches any future drift where the lock is
      // dropped.
      const updated = await tx
        .update(tickets)
        .set({
          status: "voided",
          actualPayoutMicro: stakeMicro,
          settledAt: new Date(),
          rejectReason: body.reason,
        })
        .where(and(eq(tickets.id, params.id), eq(tickets.status, "accepted")))
        .returning({ id: tickets.id });
      if (updated.length !== 1) {
        throw new ConflictError("ticket_status_changed", "ticket_status_changed");
      }

      // Release the lock + credit back the full stake on the ticket's
      // currency wallet.
      await tx
        .update(wallets)
        .set({
          lockedMicro: sql`${wallets.lockedMicro} - ${stakeMicro}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(wallets.userId, existing.userId),
            eq(wallets.currency, ticketCurrency),
          ),
        );

      // Ledger: bet_refund row (unique on (type, ref_type, ref_id) so
      // replay is safe).
      await tx.insert(walletLedger).values({
        userId: existing.userId,
        currency: ticketCurrency,
        deltaMicro: stakeMicro,
        type: "bet_refund",
        refType: "ticket",
        refId: params.id,
        memo: `admin_void:${body.reason}`,
      }).onConflictDoNothing();

      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "ticket.void",
        targetType: "ticket",
        targetId: params.id,
        beforeJson: {
          status: existing.status,
          stakeMicro: existing.stakeMicro.toString(),
        },
        afterJson: {
          status: "voided",
          reason: body.reason,
          refundMicro: stakeMicro.toString(),
        },
        ipInet: request.ip ?? null,
      });

      return existing.userId;
    });

    // Notify the user via ws-gateway user channel.
    try {
      await app.redis.publish(
        USER_CHANNEL_PREFIX + userIdForPublish,
        JSON.stringify({
          type: "ticket",
          ticketId: params.id,
          status: "voided",
          rejectReason: body.reason,
        }),
      );
    } catch {
      // best-effort
    }

    return { ok: true, ticketId: params.id, status: "voided" };
  });
}
