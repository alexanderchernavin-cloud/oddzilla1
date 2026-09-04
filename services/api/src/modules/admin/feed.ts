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
//     - Every `live` MATCH is moved to status='suspended', so the match
//       leaves the offer with its markets. Suspending markets alone left
//       matches asserting `live` with nothing able to walk the claim
//       back: the replay re-asserts only what Oddin still carries, and a
//       match it has dropped has no route to a terminal status. This
//       mirrors step 3 of feed-ingester's
//       store.FlushAndSuspendActiveCatalog; keep the two in step.
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
import { eq, sql } from "drizzle-orm";
import { adminAuditLog, amqpState, feedControl } from "@oddzilla/db";
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

// ── Feed source switch ──────────────────────────────────────────────────
//
// State lives in the singleton `feed_control` row (migration 0095), read
// every 2 s by services/feed-ingester (runSourceSwitch) and
// services/bifrost-feed (internal/gate). The first cut used Redis keys;
// production Redis is an allkeys-lru cache and evicted them on day one,
// silently undoing a forced Backup. Operator state must survive that.
const feedSourceSchema = z.enum(["auto", "prod", "backup"]);
type FeedSource = z.infer<typeof feedSourceSchema>;

const sourceBody = z.object({
  source: feedSourceSchema,
  // Forcing the backup suspends the whole active catalogue and ignores
  // the AMQP feed until switched back; require the same kind of explicit
  // confirmation the recovery flush does.
  confirm: z.literal("switch-feed-source").optional(),
});

const sourceRateLimit = {
  rateLimit: { max: 10, timeWindow: "1 minute" },
};

export default async function adminFeedRoutes(app: FastifyInstance) {
  // PUT /admin/feed/source  { source: "auto" | "prod" | "backup", confirm? }
  //   auto    prod Oddin (AMQP) with automatic failover to the Bifrost
  //           backup after BIFROST_TAKEOVER_AFTER_SECONDS of silence
  //   prod    prod Oddin only; the backup never publishes
  //   backup  backup Oddin forced: feed-ingester suspends the catalogue
  //           and stops applying AMQP odds; bifrost-feed re-feeds it
  //           within seconds. Settlement keeps consuming AMQP as well —
  //           its apply-once dedup makes dual sources safe, and cancel /
  //           rollback messages exist only there.
  app.put("/admin/feed/source", { config: sourceRateLimit }, async (request) => {
    const admin = request.requireRole("admin");
    const body = sourceBody.parse(request.body ?? {});
    if (body.source === "backup" && body.confirm !== "switch-feed-source") {
      throw new BadRequestError(
        "confirm_required",
        'source=backup requires {"confirm":"switch-feed-source"} in the body',
      );
    }
    const nowUnix = Math.floor(Date.now() / 1000);
    const before = await app.db.transaction(async (tx) => {
      const [prev] = await tx
        .select({ source: feedControl.source })
        .from(feedControl)
        .where(eq(feedControl.id, 1))
        .for("update");
      // flushed_at is reset so bifrost-feed waits for feed-ingester's fresh
      // acknowledgement of THIS switch before re-emitting.
      await tx
        .update(feedControl)
        .set({
          source: body.source,
          switchedAt: sql`NOW()`,
          switchedBy: admin.id,
          flushedAt: null,
          updatedAt: sql`NOW()`,
        })
        .where(eq(feedControl.id, 1));
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "feed.source_switch",
        targetType: "feed_control",
        targetId: "1",
        beforeJson: { source: prev?.source ?? "auto" },
        afterJson: { source: body.source, switchedUnix: nowUnix },
        ipInet: request.ip ?? null,
      });
      return prev?.source ?? "auto";
    });
    request.log.warn({ from: before, to: body.source, admin: admin.id }, "feed source switched");
    return { ok: true, source: body.source, switchedUnix: nowUnix };
  });

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
        let suspendedMatchIds: string[] = [];

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

          // Third step: take the MATCHES off the offer too, mirroring
          // feed-ingester's store.FlushAndSuspendActiveCatalog. Without
          // it this endpoint performs a half-flush — markets suspended
          // while every match keeps asserting `live` — and nothing walks
          // that claim back, because the replay re-asserts only what
          // Oddin still carries and a match it has dropped has no route
          // to a terminal status. `live` only: a `not_started` match
          // makes no false claim and its markets are already suspended.
          const matchResult = (await tx.execute(sql`
            UPDATE matches
               SET status = 'suspended'::match_status, updated_at = NOW()
             WHERE status = 'live'
            RETURNING id
          `)) as unknown as Array<{ id: string | number }>;
          suspendedMatchIds = (matchResult ?? []).map((r) => String(r.id));
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
            flushedMatches: suspendedMatchIds.length,
          },
          ipInet: request.ip ?? null,
        });

        return {
          activeMarkets,
          flushedMarkets,
          flushedOutcomes,
          suspendedMatchIds,
        };
      });

    let txResult:
      | {
          activeMarkets: number;
          flushedMarkets: number;
          flushedOutcomes: number;
          suspendedMatchIds: string[];
        }
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

    // Tell open pages the matches left the offer, so the LIVE pill goes
    // in the same moment the prices do rather than surviving until a hard
    // reload. Same envelope feed-ingester's Bus.PublishMatchStatus emits
    // on the shared odds:match:{id} channel. Strictly after commit and
    // best-effort: pub/sub is a fan-out, the source of truth is the row
    // we just wrote, and a publish failure must not undo a durable flush.
    if (txResult.suspendedMatchIds.length > 0) {
      const ts = Date.now();
      await Promise.all(
        txResult.suspendedMatchIds.map(async (matchId) => {
          try {
            await app.redis.publish(
              `odds:match:${matchId}`,
              JSON.stringify({
                type: "matchStatus",
                matchId,
                status: "suspended",
                ts,
              }),
            );
          } catch (err) {
            request.log.debug(
              { err, matchId },
              "publish match status after admin flush failed",
            );
          }
        }),
      );
    }

    return {
      ok: true,
      cursorMs,
      hours,
      flushedMarkets: txResult.flushedMarkets,
      flushedOutcomes: txResult.flushedOutcomes,
      flushedMatches: txResult.suspendedMatchIds.length,
      activeMarketsBefore: txResult.activeMarkets,
    };
  },
  );

  // ── Fonbet feed on/off switch ─────────────────────────────────────────
  //
  // Same state model as the source switch: the feed_control singleton
  // (migration 0099 adds fonbet_enabled + handshake columns), read every
  // 2 s by services/fonbet-ingester. NULL = never switched from here, the
  // FONBET_ENABLED env default applies; TRUE / FALSE wins over env and
  // survives restarts and deploys. OFF suspends every Fonbet market
  // (status -1, prices kept — invisible to the catalog, placement rejects)
  // and stops polling Fonbet; ON boots the feed and re-activates whatever
  // Fonbet still quotes. The settlement worker runs only while the feed is
  // on (and only with FONBET_SETTLE_ENABLED), so tickets on Fonbet markets
  // stay open while the switch is off.
  const fonbetBody = z.object({ enabled: z.boolean() });

  // PUT /admin/feed/fonbet  { enabled: boolean }
  app.put("/admin/feed/fonbet", { config: sourceRateLimit }, async (request) => {
    const admin = request.requireRole("admin");
    const body = fonbetBody.parse(request.body ?? {});
    const nowUnix = Math.floor(Date.now() / 1000);
    const before = await app.db.transaction(async (tx) => {
      const [prev] = await tx
        .select({ enabled: feedControl.fonbetEnabled })
        .from(feedControl)
        .where(eq(feedControl.id, 1))
        .for("update");
      await tx
        .update(feedControl)
        .set({
          fonbetEnabled: body.enabled,
          fonbetSwitchedAt: sql`NOW()`,
          fonbetSwitchedBy: admin.id,
          updatedAt: sql`NOW()`,
        })
        .where(eq(feedControl.id, 1));
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "feed.fonbet_switch",
        targetType: "feed_control",
        targetId: "1",
        beforeJson: { enabled: prev?.enabled ?? null },
        afterJson: { enabled: body.enabled, switchedUnix: nowUnix },
        ipInet: request.ip ?? null,
      });
      return prev?.enabled ?? null;
    });
    request.log.warn({ from: before, to: body.enabled, admin: admin.id }, "fonbet feed switched");
    return { ok: true, enabled: body.enabled, switchedUnix: nowUnix };
  });

  // GET /admin/feed/fonbet-status — switch position + what the ingester
  // applied (Postgres) and the service's live status hash (Redis,
  // refreshed every 5 s with a 120 s TTL; absent = service offline).
  app.get("/admin/feed/fonbet-status", async (request) => {
    request.requireRole("admin");
    const [hash, controlRows] = await Promise.all([
      app.redis.hgetall("fonbet:feed:status"),
      app.db.select().from(feedControl).where(eq(feedControl.id, 1)).limit(1),
    ]);
    const control = controlRows[0];
    const nowUnix = Math.floor(Date.now() / 1000);
    const num = (key: string): number | null => {
      const v = hash[key];
      if (v == null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const flag = (key: string): boolean | null => {
      const v = hash[key];
      if (v == null || v === "") return null;
      return v === "1";
    };
    const dateUnix = (d: Date | null | undefined): number | null =>
      d ? Math.floor(d.getTime() / 1000) : null;
    const heartbeat = num("heartbeat_unix");
    return {
      switch: {
        // null = never switched from the backoffice; env default applies.
        enabled: control?.fonbetEnabled ?? null,
        switchedUnix: dateUnix(control?.fonbetSwitchedAt),
        switchedBy: control?.fonbetSwitchedBy ?? null,
        appliedEnabled: control?.fonbetAppliedEnabled ?? null,
        appliedUnix: dateUnix(control?.fonbetAppliedAt),
      },
      service: {
        online: heartbeat != null && nowUnix - heartbeat < 120,
        heartbeatUnix: heartbeat,
        // What the service is doing right now and why.
        envDefault: flag("env_default"),
        effectiveEnabled: flag("effective_enabled"),
        switchSource: hash.switch_source || null, // "admin" | "env"
        running: flag("running") === true,
        catalogSuspended: flag("catalog_suspended") === true,
        settleEnabled: flag("settle_enabled") === true,
        matches: num("matches"),
        outcomes: num("outcomes"),
        lastSnapshotUnix: num("last_snapshot_unix"),
        lastError: hash.last_error || null,
        lastErrorUnix: num("last_error_unix"),
      },
    };
  });

  // Backup feed (services/bifrost-feed) status. The service refreshes a
  // Redis hash every 5 s with a 120 s TTL; feed-ingester stamps the
  // primary-liveness key on every AMQP delivery. Both are read here so
  // the operator sees, on one card, whether the primary is alive, whether
  // the backup is publishing, and what it has published.
  app.get("/admin/feed/backup-status", async (request) => {
    request.requireRole("admin");
    const [hash, primaryRaw, connectedRaw, controlRows] = await Promise.all([
      app.redis.hgetall("bifrost:feed:status"),
      app.redis.get("feed:primary:last_msg_unix"),
      // Refreshed every 2 s with a 15 s TTL while feed-ingester holds
      // an open AMQP connection; absent = disconnected.
      app.redis.get("feed:primary:connected_unix"),
      app.db.select().from(feedControl).where(eq(feedControl.id, 1)).limit(1),
    ]);
    const control = controlRows[0];
    const nowUnix = Math.floor(Date.now() / 1000);
    const num = (key: string): number | null => {
      const v = hash[key];
      if (v == null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const toUnix = (raw: string | null): number | null => {
      if (raw == null) return null;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const dateUnix = (d: Date | null | undefined): number | null =>
      d ? Math.floor(d.getTime() / 1000) : null;
    const sourceRaw = control?.source ?? null;
    const switchedBy = control?.switchedBy ?? null;
    const appliedRaw = control?.appliedSource ?? null;
    const heartbeat = num("heartbeat_unix");
    const primaryLast = primaryRaw != null ? Number(primaryRaw) : null;
    return {
      online: heartbeat != null && nowUnix - heartbeat < 120,
      heartbeatUnix: heartbeat,
      mode: hash.mode ?? null,
      defaultMode: hash.default_mode ?? null,
      waitingForFlush: hash.waiting_for_flush === "1",
      source: {
        // Effective switch position; absent key means auto.
        requested: feedSourceSchema.safeParse(sourceRaw).success
          ? (sourceRaw as FeedSource)
          : "auto",
        switchedUnix: dateUnix(control?.switchedAt),
        switchedBy,
        // What feed-ingester last applied (null until it booted with this code).
        appliedByIngester: appliedRaw,
        flushedUnix: dateUnix(control?.flushedAt),
      },
      active: hash.active === "1",
      sinceUnix: num("since_unix"),
      connected: hash.connected === "1",
      clientId: num("client_id"),
      clientName: hash.client_name ?? null,
      trackedMatches: num("tracked"),
      frames: num("frames"),
      reconnects: num("reconnects"),
      oddsChanges: num("odds_changes"),
      settlements: num("settlements"),
      settledMarkets: num("settled_markets"),
      fixtureChanges: num("fixture_changes"),
      lastFrameUnix: num("last_frame_unix"),
      lastPublishUnix: num("last_publish_unix"),
      lastResyncUnix: num("last_resync_unix"),
      lastError: hash.last_error || null,
      lastErrorUnix: num("last_error_unix"),
      takeoverAfterSeconds: num("takeover_after_s"),
      gateTransitions: num("gate_transitions"),
      primaryLastMessageUnix:
        primaryLast != null && Number.isFinite(primaryLast) ? primaryLast : null,
      primaryStaleSeconds:
        primaryLast != null && Number.isFinite(primaryLast) ? nowUnix - primaryLast : null,
      primaryConnected: (() => {
        const c = toUnix(connectedRaw);
        return c != null && nowUnix - c < 20;
      })(),
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
