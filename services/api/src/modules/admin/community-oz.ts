// /admin/community/oz — manual Oz credit endpoint.
//
// Ships ahead of the automated trigger pipeline (engagement-floor and
// settlement hooks land in subsequent PRs). Gives ops a way to mint
// Oz against a user for testing, demos, and the period before the
// signal-side writers (analyses.inspirationCount, Go-side analyses
// settlement projection) exist.
//
// Idempotency is opt-in via a caller-supplied nonce: the admin
// constructs the request's `nonce` field and the ledger key becomes
// `admin_credit:<admin_uuid>:<nonce>`. Two POSTs with the same
// (admin, nonce) pair credit once. Without a nonce the endpoint
// generates one server-side, so a double-click on the admin UI
// double-credits — admins should set nonce explicitly when scripting.
//
// Every credit writes an admin_audit_log row, same convention as
// /admin/zillapass.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminAuditLog } from "@oddzilla/db";
import { creditOz } from "../community/oz-ledger.js";

const creditBody = z.object({
  userId: z.string().uuid(),
  // Capped to a sane upper bound to make a fat-finger ("10000000")
  // recoverable without a manual ledger reversal migration. Adjust
  // when the spend / reversal flow lands.
  delta: z.number().int().min(1).max(1_000_000),
  // Free-text label rendered alongside the row in the user's Oz
  // history later. Required so audit log isn't blind on intent.
  note: z.string().min(1).max(200),
  // Caller-supplied dedup token. Optional — endpoint generates one if
  // absent, but then retries will double-credit.
  nonce: z.string().min(1).max(80).optional(),
});

export default async function adminCommunityOzRoutes(app: FastifyInstance) {
  app.post("/admin/community/oz/credit", async (request) => {
    const admin = request.requireRole("admin");
    const body = creditBody.parse(request.body);

    const nonce =
      body.nonce ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const idempotencyKey = `admin_credit:${admin.id}:${nonce}`;

    const result = await app.db.transaction(async (tx) => {
      const credit = await creditOz(tx, {
        userId: body.userId,
        delta: body.delta,
        reason: "admin_credit",
        sourceKind: "admin",
        sourceId: nonce,
        idempotencyKey,
        createdBy: admin.id,
      });

      // Audit-log only on a fresh credit. On a dedup'd retry we don't
      // want to spam the chain with no-op entries (the prior call
      // already wrote one).
      if (credit.credited) {
        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "community.oz.credit",
          targetType: "user",
          targetId: body.userId,
          beforeJson: null,
          afterJson: {
            delta: body.delta,
            reason: "admin_credit",
            note: body.note,
            idempotencyKey,
            balanceAfter: credit.balanceAfter,
          },
          ipInet: request.ip ?? null,
        });
      }

      return credit;
    });

    return {
      credited: result.credited,
      balanceAfter: result.balanceAfter,
      idempotencyKey,
    };
  });
}
