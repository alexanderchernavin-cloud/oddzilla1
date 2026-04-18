// Admin-only feed controls.
//
// POST /admin/feed/recovery
//   Body: { flushOdds?: boolean, hours?: number }
//   Rewinds the Oddin AMQP cursor by `hours` (default 24, max 72 — Oddin's
//   recovery window) and sends `pg_notify('feed_recovery', ...)` which the
//   feed-ingester LISTENs on. Feed-ingester then calls
//   `InitiateRecovery` for both producers, causing Oddin to replay every
//   message since the new cursor timestamp. Markets that were stuck
//   "LIVE" without odds get re-populated; new matches that were missed
//   appear.
//
//   When `flushOdds=true`, also suspends all currently-active markets
//   (status=-1) and nulls their published_odds, so the UI shows a clean
//   "Suspended" state until recovery re-populates. Does not touch
//   settled/closed matches. Never touches `settlements` — that table is
//   append-only and apply-once.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { adminAuditLog, amqpState } from "@oddzilla/db";

const bodySchema = z.object({
  flushOdds: z.boolean().optional(),
  hours: z.coerce.number().int().min(1).max(72).optional(),
});

export default async function adminFeedRoutes(app: FastifyInstance) {
  app.post("/admin/feed/recovery", async (request) => {
    const admin = request.requireRole("admin");
    const body = bodySchema.parse(request.body ?? {});
    const hours = body.hours ?? 24;
    const flush = Boolean(body.flushOdds);

    // Target cursor = now - hours. Oddin rejects recovery requests older
    // than ~3 days so this is clamped at 72h by the schema above.
    const cursorMs = Date.now() - hours * 60 * 60 * 1000;

    // Count currently-active markets so the audit log + response has a
    // meaningful "affected" number. These are the ones flush will
    // suspend and recovery will re-activate.
    const marketCountRows = (await app.db.execute(sql`
      SELECT COUNT(*)::text AS cnt
      FROM markets m
      JOIN matches ma ON ma.id = m.match_id
      WHERE m.status = 1
        AND ma.status IN ('not_started', 'live')
    `)) as unknown as Array<{ cnt: string }>;
    const activeMarkets = Number(marketCountRows[0]?.cnt ?? "0");

    let flushedMarkets = 0;
    let flushedOutcomes = 0;

    if (flush) {
      const marketResult = await app.db.execute(sql`
        UPDATE markets
           SET status = -1, updated_at = NOW()
          FROM matches ma
         WHERE ma.id = markets.match_id
           AND markets.status = 1
           AND ma.status IN ('not_started', 'live')
      `);
      flushedMarkets =
        typeof (marketResult as { count?: number }).count === "number"
          ? (marketResult as { count: number }).count
          : 0;

      const outcomeResult = await app.db.execute(sql`
        UPDATE market_outcomes
           SET published_odds = NULL,
               active = FALSE,
               updated_at = NOW()
          FROM markets m
          JOIN matches ma ON ma.id = m.match_id
         WHERE market_outcomes.market_id = m.id
           AND ma.status IN ('not_started', 'live')
      `);
      flushedOutcomes =
        typeof (outcomeResult as { count?: number }).count === "number"
          ? (outcomeResult as { count: number }).count
          : 0;
    }

    // Rewind the cursor for both producers. We want to force it
    // backwards, so the upsert overwrites unconditionally (not
    // GREATEST, which is what the normal ingest path uses).
    await app.db
      .insert(amqpState)
      .values([
        { key: "producer:1", afterTs: BigInt(cursorMs) },
        { key: "producer:2", afterTs: BigInt(cursorMs) },
      ])
      .onConflictDoUpdate({
        target: amqpState.key,
        set: {
          afterTs: sql`EXCLUDED.after_ts`,
          updatedAt: sql`NOW()`,
        },
      });

    // pg_notify wakes the feed-ingester LISTEN loop. Payload is JSON so
    // the ingester can log what triggered the replay. Ingester reads the
    // fresh cursor from amqp_state rather than trusting the payload.
    const payload = JSON.stringify({
      requestedBy: admin.id,
      cursorMs,
      flush,
    });
    await app.db.execute(sql`SELECT pg_notify('feed_recovery', ${payload})`);

    await app.db.insert(adminAuditLog).values({
      actorUserId: admin.id,
      action: "feed.recovery",
      targetType: "amqp_state",
      targetId: "producer:1,producer:2",
      beforeJson: { activeMarkets },
      afterJson: {
        cursorMs,
        hours,
        flush,
        flushedMarkets,
        flushedOutcomes,
      },
      ipInet: request.ip ?? null,
    });

    return {
      ok: true,
      cursorMs,
      hours,
      flushedMarkets,
      flushedOutcomes,
      activeMarketsBefore: activeMarkets,
    };
  });

  // Read-only status so the admin UI can show the current cursor lag
  // before the operator hits the button.
  app.get("/admin/feed/status", async (request) => {
    request.requireRole("admin");
    const rows = await app.db.select().from(amqpState);
    const now = Date.now();
    const producers = rows
      .filter((r) => r.key.startsWith("producer:"))
      .map((r) => {
        const afterMs = Number(r.afterTs);
        return {
          key: r.key,
          afterMs,
          afterIso: afterMs > 0 ? new Date(afterMs).toISOString() : null,
          staleSeconds: afterMs > 0 ? Math.floor((now - afterMs) / 1000) : null,
          updatedAt: r.updatedAt.toISOString(),
        };
      })
      .sort((a, b) => a.key.localeCompare(b.key));
    return { producers };
  });
}
