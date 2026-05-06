// /admin/community/* endpoints. Admin-only.
//
// POST /admin/community/backfill
//   Idempotent sweep that projects every settled / cashed_out / voided
//   ticket missing a `community_tickets` row, plus refreshes any rows
//   whose source-of-truth `tickets` row has drifted (e.g. a re-settle
//   that landed before the projection write hook). Safe to run
//   repeatedly — the upsert is keyed on `community_tickets.ticket_id
//   UNIQUE`.
//
// Why a separate admin endpoint at all: the Go settlement service is
// the authoritative writer at settle-time, but a deploy ordering or a
// transient projection failure can leave gaps. Operators can recover
// by hitting this endpoint without coordinating a settlement replay.

import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { CommunityBackfillResponse } from "@oddzilla/types";
import { writeCommunityProjection } from "../community/projection.js";

// One transaction per batch keeps the lock window short on the
// multi-row upsert. 500 is small enough that the GIN-index update on
// sport_ids stays linear-time per row, large enough that the round-trip
// per batch dominates over the SQL execution.
const BATCH_SIZE = 500;

export default async function adminCommunityRoutes(app: FastifyInstance) {
  app.post(
    "/admin/community/backfill",
    async (request): Promise<CommunityBackfillResponse> => {
      request.requireRole("admin");

      // Sweep all settled / cashed_out / voided tickets that are
      // either missing from the projection OR whose status / payout /
      // settled_at has drifted. Pulling the candidate set explicitly
      // (rather than scanning the entire `tickets` table inside the
      // upsert) keeps the work bounded and lets us return a useful
      // count to the operator.
      const candidates = await app.db.execute<{
        ticketId: string;
        [key: string]: unknown;
      }>(sql`
        SELECT t.id AS ticket_id
          FROM tickets t
          LEFT JOIN community_tickets c ON c.ticket_id = t.id
         WHERE t.status::text IN ('settled', 'cashed_out', 'voided')
           AND (
             c.ticket_id IS NULL
             OR c.status::text IS DISTINCT FROM t.status::text
             OR c.payout_micro IS DISTINCT FROM COALESCE(t.actual_payout_micro, 0)
             OR c.settled_at   IS DISTINCT FROM t.settled_at
           )
         ORDER BY t.settled_at DESC NULLS LAST
      `);

      const ticketIds = candidates.map((r) => r.ticketId);
      let upserted = 0;
      for (let i = 0; i < ticketIds.length; i += BATCH_SIZE) {
        const batch = ticketIds.slice(i, i + BATCH_SIZE);
        upserted += await writeCommunityProjection(app.db, batch);
      }

      return {
        scanned: ticketIds.length,
        upserted,
      };
    },
  );
}
