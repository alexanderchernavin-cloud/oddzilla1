// Admin-only feed controls.
//
// POST /admin/feed/recovery
//   Body: {
//     flushOdds?: boolean,
//     hours?: number,
//     drainPhantoms?: boolean,
//     drainAgeHours?: number,
//   }
//   Rewinds the Oddin AMQP cursor by `hours` (default 48, max 72 — Oddin
//   actually rejects requests older than 3 days with a 404 / "Supported
//   is only 3 day range", so 72 is the hard cap) and sends
//   `pg_notify('feed_recovery', ...)` which the feed-ingester LISTENs
//   on. Feed-ingester then calls `InitiateRecovery` for both producers,
//   causing Oddin to replay every message since the new cursor
//   timestamp. Markets that were stuck "LIVE" without odds get
//   re-populated; new matches that were missed appear.
//
//   When `flushOdds=true` (default), also suspends all currently-active
//   markets (status=-1) and nulls their published_odds, raw_odds, AND
//   probability, plus flips market_outcomes.active=false, so the UI
//   shows a clean "Suspended" state with no stale prices and Tiple/
//   Tippot can't price off pre-flush probability snapshots until the
//   replay refills them. Does not touch settled/closed matches. Never
//   touches `settlements` — that table is append-only and apply-once.
//
//   When `drainPhantoms=true` (default), also fires
//   `pg_notify('phantom_drain', '{"hours":N}')`. Feed-ingester listens
//   on this channel and re-pulls every match still flagged `live` more
//   than `drainAgeHours` after its scheduled start from Oddin's REST
//   fixture endpoint, so closed/ended matches whose
//   match_status_change we missed during the outage get their
//   matches.status corrected. AMQP replay alone cannot fix these
//   because Oddin won't replay match_status_change for matches older
//   than ~3 days; REST fixture state is the only source of truth.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { adminAuditLog, amqpState } from "@oddzilla/db";

const bodySchema = z.object({
  flushOdds: z.boolean().optional(),
  hours: z.coerce.number().int().min(1).max(72).optional(),
  drainPhantoms: z.boolean().optional(),
  drainAgeHours: z.coerce.number().int().min(1).max(168).optional(),
});

export default async function adminFeedRoutes(app: FastifyInstance) {
  app.post("/admin/feed/recovery", async (request) => {
    const admin = request.requireRole("admin");
    const body = bodySchema.parse(request.body ?? {});
    // Default 48h (2 days). Wide enough to catch any future fixture that
    // had its last odds_change up to two days ago, so probability gets
    // refilled across the catalog. Oddin's hard limit is 3 days; max
    // stays at 72.
    const hours = body.hours ?? 48;
    // Default true: the operator hits this button when the catalog is
    // visibly stale, which is exactly when we want a clean slate before
    // the replay. They can opt out via { flushOdds: false }.
    const flush = body.flushOdds ?? true;
    // Default true: Oddin won't replay match_status_change beyond ~3
    // days, so a separate REST-driven sweep is the only way to clean
    // up stuck-live rows after a long outage. 6h matches the CLI flag
    // default and is well above any plausible esports series length.
    const drainPhantoms = body.drainPhantoms ?? true;
    const drainAgeHours = body.drainAgeHours ?? 6;

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
               raw_odds       = NULL,
               probability    = NULL,
               active         = FALSE,
               updated_at     = NOW()
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

    // Count phantom-live candidates so the response and audit log
    // surface what the drain will hit. The actual REST fan-out happens
    // inside feed-ingester at 5 RPS — this number is informational.
    let phantomCount = 0;
    if (drainPhantoms) {
      const phantomRows = (await app.db.execute(sql`
        SELECT COUNT(*)::text AS cnt
          FROM matches
         WHERE status = 'live'
           AND scheduled_at IS NOT NULL
           AND scheduled_at < NOW() - make_interval(hours => ${drainAgeHours})
           AND provider_urn LIKE 'od:match:%'
      `)) as unknown as Array<{ cnt: string }>;
      phantomCount = Number(phantomRows[0]?.cnt ?? "0");

      const drainPayload = JSON.stringify({
        requestedBy: admin.id,
        hours: drainAgeHours,
      });
      await app.db.execute(
        sql`SELECT pg_notify('phantom_drain', ${drainPayload})`,
      );
    }

    await app.db.insert(adminAuditLog).values({
      actorUserId: admin.id,
      action: "feed.recovery",
      targetType: "amqp_state",
      targetId: "producer:1,producer:2",
      beforeJson: { activeMarkets, phantomCandidates: phantomCount },
      afterJson: {
        cursorMs,
        hours,
        flush,
        flushedMarkets,
        flushedOutcomes,
        drainPhantoms,
        drainAgeHours: drainPhantoms ? drainAgeHours : null,
        phantomCandidates: phantomCount,
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
      drainPhantoms,
      drainAgeHours: drainPhantoms ? drainAgeHours : null,
      phantomCandidates: phantomCount,
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
