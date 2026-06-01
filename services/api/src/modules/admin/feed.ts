// Admin-only feed controls.
//
// POST /admin/feed/recovery
//   Body: {
//     flushOdds?: boolean,
//     hours?: number,
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
//   When `flushOdds=true` (default), every active market is fully
//   flushed before the replay so only what Oddin re-confirms over the
//   rewind window comes back. The flush is SUSPEND-based, NOT DELETE:
//
//     - Every market on a not_started/live match at status=1 is flipped
//       to status=-1 (suspended), and its outcomes have published_odds /
//       raw_odds / probability nulled and active=false. That is a
//       complete odds wipe — the catalog filter gates on status=1, so a
//       suspended market is invisible to the storefront exactly like a
//       deleted one, and bet placement / Tiple / Tippot can't price off
//       stale snapshots until the replay refills them.
//
//   We deliberately do NOT `DELETE FROM markets`: a bulk delete deadlocks
//   against the live feed-ingester's concurrent market upserts (the
//   "something went wrong" 500 this path used to throw) and FK-races
//   concurrent settlement INSERTs. An UPDATE on the parent triggers no
//   child FK checks and has the identical storefront end-state. This is
//   the same race-safe approach the auto-recovery path uses
//   (store.FlushAndSuspendActiveCatalog). The whole operation runs in one
//   transaction (so a failure can't leave a half-flushed catalog or a
//   rewound cursor with no replay), bounded by a lock_timeout and retried
//   on transient lock contention; if the feed stays too busy it returns a
//   typed 503 instead of an unhandled 500.
//
//   Closed/cancelled matches are never touched (terminal history). The
//   `settlements` table is never touched — append-only and apply-once.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { adminAuditLog, amqpState } from "@oddzilla/db";
import { BadRequestError, ServiceUnavailableError } from "../../lib/errors.js";

const bodySchema = z.object({
  flushOdds: z.boolean().optional(),
  hours: z.coerce.number().int().min(1).max(72).optional(),
  // Required when flushOdds is true (i.e. the caller is asking to
  // wipe the active catalog before the replay). Raises the cost to a
  // stolen-admin-token attacker spamming this endpoint to disrupt
  // service: they now need to know the exact confirm string in
  // addition to the cookie. Legitimate operators paste it once.
  confirm: z.literal("flush-active-catalog").optional(),
});

// Recovery rewinds the AMQP cursor by up to 72 h and triggers Oddin to
// replay every message in that window. It's an expensive operation
// against Oddin's REST quota AND it nukes published_odds for every
// active market until the replay refills them. A scripted replay (e.g.
// from a compromised admin token in a loop) would tar-pit the
// storefront and burn quota. 3-per-hour is plenty for legitimate ops.
const recoveryRateLimit = {
  rateLimit: { max: 3, timeWindow: "1 hour" },
};

// The flush UPDATEs can still lose a deadlock against the hot feed-ingester
// (40P01) or hit our lock_timeout (55P03). Both are transient — retry a few
// times before surfacing a typed 503.
const RECOVERY_MAX_ATTEMPTS = 3;

// postgres.js puts the SQLSTATE on `.code`; drizzle wraps the driver error,
// so walk the cause chain looking for a deadlock / lock-not-available code.
function isTransientLockError(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 5 && e; i++) {
    const code = (e as { code?: string }).code;
    if (code === "40P01" /* deadlock_detected */ || code === "55P03" /* lock_not_available */) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export default async function adminFeedRoutes(app: FastifyInstance) {
  app.post(
    "/admin/feed/recovery",
    { config: recoveryRateLimit },
    async (request) => {
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

    if (flush && body.confirm !== "flush-active-catalog") {
      // Catalog wipe needs the magic string, so a one-shot stolen-token
      // POST {} silently re-runs the destructive default. The audit log
      // captures the rejection too — investigate.
      await app.db.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "feed.recovery.confirm_missing",
        targetType: "amqp_state",
        targetId: "producer:1,producer:2",
        beforeJson: null,
        afterJson: { reason: "missing_or_wrong_confirm_string", flush, hours: body.hours ?? 48 },
        ipInet: request.ip ?? null,
      });
      throw new BadRequestError(
        "confirm_required",
        'flushOdds=true requires {"confirm":"flush-active-catalog"} in the body',
      );
    }

    // Target cursor = now - hours. Oddin rejects recovery requests older
    // than ~3 days so this is clamped at 72h by the schema above.
    const cursorMs = Date.now() - hours * 60 * 60 * 1000;

    // pg_notify wakes the feed-ingester LISTEN loop. Payload is JSON so
    // the ingester can log what triggered the replay. Ingester reads the
    // fresh cursor from amqp_state rather than trusting the payload.
    const payload = JSON.stringify({
      requestedBy: admin.id,
      cursorMs,
      flush,
    });

    // One transaction: full odds flush (SUSPEND, never DELETE) + cursor
    // rewind + recovery notify + audit. Atomic, so a failure can't strand
    // a half-flushed catalog or a rewound cursor that never triggered a
    // replay. pg_notify is transactional — it fires on COMMIT, exactly
    // when the flush is durable. lock_timeout bounds how long we'll block
    // behind the live feed's row locks; the outer loop retries transient
    // deadlock / lock-timeout before giving up with a typed 503.
    const runRecoveryTxn = () =>
      app.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);

        const marketCountRows = (await tx.execute(sql`
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
          // Full odds flush: suspend EVERY active market on a
          // not_started/live fixture and null its outcome prices. No
          // DELETE — see the header comment for why (deadlock + FK race
          // against the live feed). Storefront end-state is identical:
          // status=-1 is invisible to the catalog filter.
          const marketResult = await tx.execute(sql`
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

          const outcomeResult = await tx.execute(sql`
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

        // Rewind the cursor for both producers. Force it backwards, so
        // the upsert overwrites unconditionally (not GREATEST, which is
        // what the normal ingest path uses).
        await tx
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

        await tx.execute(sql`SELECT pg_notify('feed_recovery', ${payload})`);

        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "feed.recovery",
          targetType: "amqp_state",
          targetId: "producer:1,producer:2",
          beforeJson: { activeMarkets },
          afterJson: {
            cursorMs,
            hours,
            flush,
            mode: "suspend",
            flushedMarkets,
            flushedOutcomes,
          },
          ipInet: request.ip ?? null,
        });

        return { activeMarkets, flushedMarkets, flushedOutcomes };
      });

    let txResult:
      | { activeMarkets: number; flushedMarkets: number; flushedOutcomes: number }
      | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        txResult = await runRecoveryTxn();
        break;
      } catch (err) {
        if (isTransientLockError(err)) {
          if (attempt >= RECOVERY_MAX_ATTEMPTS) {
            request.log.warn(
              { attempt },
              "feed recovery flush exhausted retries on lock contention",
            );
            throw new ServiceUnavailableError(
              "Feed recovery could not get a clean lock window — the live feed is busy. Nothing was changed; try again in a few seconds.",
              "recovery_lock_contended",
            );
          }
          request.log.warn(
            { attempt },
            "feed recovery flush hit lock contention; retrying",
          );
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
          continue;
        }
        throw err;
      }
    }

    return {
      ok: true,
      cursorMs,
      hours,
      flushedMarkets: txResult.flushedMarkets,
      flushedOutcomes: txResult.flushedOutcomes,
      activeMarketsBefore: txResult.activeMarkets,
    };
  },
  );

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
