// /admin/tickets endpoints. Currently just manual void (cancel + refund).
//
// Manual void transitions an accepted ticket to `voided` and issues a
// full refund to the user's wallet. Single transaction; audit-logged.
// Idempotent via the wallet_ledger unique partial index — replaying the
// same admin action on the same ticket is a no-op ledger-wise.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import {
  tickets,
  wallets,
  walletLedger,
  adminAuditLog,
} from "@oddzilla/db";
import {
  BadRequestError,
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

    const [existing] = await app.db
      .select()
      .from(tickets)
      .where(eq(tickets.id, params.id))
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

    await app.db.transaction(async (tx) => {
      // Flip to voided with a full refund.
      await tx
        .update(tickets)
        .set({
          status: "voided",
          actualPayoutMicro: stakeMicro,
          settledAt: new Date(),
          rejectReason: body.reason,
        })
        .where(eq(tickets.id, params.id));

      // Release the lock + credit back the full stake.
      await tx
        .update(wallets)
        .set({
          lockedMicro: sql`${wallets.lockedMicro} - ${stakeMicro}`,
          updatedAt: new Date(),
        })
        .where(eq(wallets.userId, existing.userId));

      // Ledger: bet_refund row (unique on (type, ref_type, ref_id) so
      // replay is safe).
      await tx.insert(walletLedger).values({
        userId: existing.userId,
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
    });

    // Notify the user via ws-gateway user channel.
    try {
      await app.redis.publish(
        USER_CHANNEL_PREFIX + existing.userId,
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
