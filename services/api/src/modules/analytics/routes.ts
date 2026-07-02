// First-party FE analytics intake. The storefront tracker
// (apps/web/src/lib/analytics/) batches journey events + sampled mouse
// trails and POSTs them here every few seconds (fetch keepalive /
// sendBeacon on pagehide). Anonymous visitors are first-class: the auth
// plugin populates request.user when the access cookie verifies, and we
// simply link the session row on the first authed flush.
//
// Apply-once: the client stamps a per-session monotonic seq on every
// event and mouse batch; inserts are ON CONFLICT DO NOTHING on
// (session_id, seq), and the denormalised session counters are bumped by
// the count of rows that actually landed — so a batch re-delivered by
// pagehide double-fire never double-counts.

import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  analyticsEvents,
  analyticsMouseBatches,
  analyticsSessions,
} from "@oddzilla/db";
import {
  ANALYTICS_EVENT_KINDS,
  ANALYTICS_MAX_EVENTS_PER_REQUEST,
  ANALYTICS_MAX_MOUSE_BATCHES_PER_REQUEST,
  ANALYTICS_MAX_POINTS_PER_BATCH,
} from "@oddzilla/types";

const MAX_PATH_LENGTH = 300;
const MAX_SECTION_LENGTH = 40;
const MAX_REFERRER_LENGTH = 600;
const MAX_USER_AGENT_LENGTH = 400;
// A click payload is a small descriptor; anything bigger is a client bug
// or abuse — dropped, not truncated mid-JSON.
const MAX_PAYLOAD_JSON_CHARS = 2048;
const MAX_SEQ = 100_000_000;
const MAX_VIEWPORT_PX = 20_000;

// Client clocks drift and pagehide batches can arrive late; clamp into a
// window instead of trusting arbitrary timestamps.
const CLOCK_PAST_SLACK_MS = 6 * 60 * 60 * 1000;
const CLOCK_FUTURE_SLACK_MS = 5 * 60 * 1000;

const pathField = z.string().min(1).max(MAX_PATH_LENGTH);

const wireEventSchema = z.object({
  seq: z.number().int().min(0).max(MAX_SEQ),
  kind: z.enum(ANALYTICS_EVENT_KINDS),
  ts: z.number().finite(),
  path: pathField.optional(),
  section: z.string().min(1).max(MAX_SECTION_LENGTH).optional(),
  payload: z.record(z.unknown()).optional(),
});

const mouseBatchSchema = z.object({
  seq: z.number().int().min(0).max(MAX_SEQ),
  path: pathField,
  startTs: z.number().finite(),
  durationMs: z.number().int().min(0).max(600_000),
  viewportW: z.number().int().min(1).max(MAX_VIEWPORT_PX),
  viewportH: z.number().int().min(1).max(MAX_VIEWPORT_PX),
  points: z
    .array(z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]))
    .min(1)
    .max(ANALYTICS_MAX_POINTS_PER_BATCH),
});

const collectBodySchema = z.object({
  sessionId: z.string().uuid(),
  startedAt: z.number().finite(),
  meta: z
    .object({
      entryPath: pathField.optional(),
      referrer: z.string().max(MAX_REFERRER_LENGTH).optional(),
      viewportW: z.number().int().min(1).max(MAX_VIEWPORT_PX).optional(),
      viewportH: z.number().int().min(1).max(MAX_VIEWPORT_PX).optional(),
    })
    .optional(),
  events: z.array(wireEventSchema).max(ANALYTICS_MAX_EVENTS_PER_REQUEST),
  mouse: z.array(mouseBatchSchema).max(ANALYTICS_MAX_MOUSE_BATCHES_PER_REQUEST).optional(),
});

function clampTs(ms: number, now: number): Date {
  const lo = now - CLOCK_PAST_SLACK_MS;
  const hi = now + CLOCK_FUTURE_SLACK_MS;
  return new Date(Math.min(Math.max(ms, lo), hi));
}

function sanitizePayload(payload: Record<string, unknown> | undefined): unknown | null {
  if (!payload) return null;
  try {
    const raw = JSON.stringify(payload);
    if (raw.length > MAX_PAYLOAD_JSON_CHARS) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function analyticsRoutes(app: FastifyInstance) {
  app.post(
    "/analytics/collect",
    {
      // Worst case is a pagehide flush carrying several mouse batches —
      // bigger than the global 64 KiB cap.
      bodyLimit: 256 * 1024,
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = collectBodySchema.parse(request.body);
      const now = Date.now();
      const userId = request.user?.id ?? null;

      const startedAt = clampTs(body.startedAt, now);
      const events = body.events.map((e) => ({
        seq: e.seq,
        kind: e.kind,
        occurredAt: clampTs(e.ts, now),
        path: e.path ?? null,
        section: e.section ?? null,
        payload: sanitizePayload(e.payload),
      }));
      const mouse = (body.mouse ?? []).map((m) => ({
        seq: m.seq,
        path: m.path,
        startedAt: clampTs(m.startTs, now),
        durationMs: m.durationMs,
        viewportW: m.viewportW,
        viewportH: m.viewportH,
        pointCount: m.points.length,
        points: m.points,
      }));

      const lastSeenMs = Math.max(
        body.startedAt,
        ...body.events.map((e) => e.ts),
        ...(body.mouse ?? []).map((m) => m.startTs + m.durationMs),
      );
      const lastSeenAt = clampTs(lastSeenMs, now);

      // Exit path = the latest page_view in this batch (by seq); the last
      // flush of the session wins overall because later flushes overwrite.
      const lastPageView = [...events]
        .reverse()
        .find((e) => e.kind === "page_view" && e.path !== null);

      const userAgent =
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"].slice(0, MAX_USER_AGENT_LENGTH)
          : null;

      await app.db.transaction(async (tx) => {
        await tx
          .insert(analyticsSessions)
          .values({
            id: body.sessionId,
            userId,
            startedAt,
            lastSeenAt,
            entryPath: body.meta?.entryPath ?? lastPageView?.path ?? null,
            exitPath: lastPageView?.path ?? null,
            referrer: body.meta?.referrer || null,
            userAgent,
            viewportW: body.meta?.viewportW ?? null,
            viewportH: body.meta?.viewportH ?? null,
          })
          .onConflictDoUpdate({
            target: analyticsSessions.id,
            set: {
              // Sessions are anonymous until the first authed flush; a
              // session never switches owner (logout mid-session keeps
              // the original attribution).
              userId: sql`COALESCE(${analyticsSessions.userId}, EXCLUDED.user_id)`,
              lastSeenAt: sql`GREATEST(${analyticsSessions.lastSeenAt}, EXCLUDED.last_seen_at)`,
              exitPath: sql`COALESCE(EXCLUDED.exit_path, ${analyticsSessions.exitPath})`,
              viewportW: sql`COALESCE(EXCLUDED.viewport_w, ${analyticsSessions.viewportW})`,
              viewportH: sql`COALESCE(EXCLUDED.viewport_h, ${analyticsSessions.viewportH})`,
            },
          });

        let insertedPageViews = 0;
        let insertedClicks = 0;
        let insertedTotal = 0;

        if (events.length > 0) {
          const inserted = await tx
            .insert(analyticsEvents)
            .values(events.map((e) => ({ ...e, sessionId: body.sessionId })))
            .onConflictDoNothing()
            .returning({ kind: analyticsEvents.kind });
          insertedTotal = inserted.length;
          for (const row of inserted) {
            if (row.kind === "page_view") insertedPageViews += 1;
            else if (row.kind === "click") insertedClicks += 1;
          }
        }

        if (mouse.length > 0) {
          await tx
            .insert(analyticsMouseBatches)
            .values(mouse.map((m) => ({ ...m, sessionId: body.sessionId })))
            .onConflictDoNothing();
        }

        if (insertedTotal > 0) {
          await tx
            .update(analyticsSessions)
            .set({
              pageViewCount: sql`${analyticsSessions.pageViewCount} + ${insertedPageViews}`,
              clickCount: sql`${analyticsSessions.clickCount} + ${insertedClicks}`,
              eventCount: sql`${analyticsSessions.eventCount} + ${insertedTotal}`,
            })
            .where(sql`${analyticsSessions.id} = ${body.sessionId}`);
        }
      });

      reply.code(204);
    },
  );
}

// ── Retention sweep ───────────────────────────────────────────────────
// Hourly, under a Redis NX lock (same shape as the monitoring sampler)
// so a future multi-instance api runs one sweep per interval. Mouse
// trails are by far the heaviest table, so they get a much shorter
// window than the journey log.

const EVENTS_RETENTION_DAYS = 90;
const MOUSE_RETENTION_DAYS = 14;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const SWEEP_BOOT_DELAY_MS = 5 * 60 * 1000;
const SWEEP_LOCK_KEY = "analytics:retention:lock";
const SWEEP_LOCK_TTL_S = 55 * 60;

export interface AnalyticsSweeperHandle {
  close(): void;
}

// postgres-js RowLists carry `count` (affected rows) but drizzle's
// execute() type doesn't surface it.
function affected(res: unknown): number {
  const count = (res as { count?: unknown })?.count;
  return typeof count === "number" ? count : 0;
}

export function startAnalyticsRetentionSweeper(app: FastifyInstance): AnalyticsSweeperHandle {
  const sweep = async () => {
    try {
      const acquired = await app.redis.set(
        SWEEP_LOCK_KEY,
        `${process.pid}:${Date.now()}`,
        "EX",
        SWEEP_LOCK_TTL_S,
        "NX",
      );
      if (!acquired) return;

      const mouse = await app.db.execute(sql`
        DELETE FROM analytics_mouse_batches
        WHERE created_at < now() - make_interval(days => ${MOUSE_RETENTION_DAYS})
      `);
      // Deleting expired sessions cascades their events + any straggler
      // mouse rows; the second DELETE catches old events on still-alive
      // sessions (a tab that stays open for months).
      const sessions = await app.db.execute(sql`
        DELETE FROM analytics_sessions
        WHERE last_seen_at < now() - make_interval(days => ${EVENTS_RETENTION_DAYS})
      `);
      const events = await app.db.execute(sql`
        DELETE FROM analytics_events
        WHERE occurred_at < now() - make_interval(days => ${EVENTS_RETENTION_DAYS})
      `);
      app.log.info(
        {
          component: "analytics-retention",
          mouseDeleted: affected(mouse),
          sessionsDeleted: affected(sessions),
          eventsDeleted: affected(events),
        },
        "analytics retention sweep complete",
      );
    } catch (err) {
      app.log.error({ err, component: "analytics-retention" }, "analytics retention sweep failed");
    }
  };

  const bootTimer = setTimeout(() => void sweep(), SWEEP_BOOT_DELAY_MS);
  bootTimer.unref?.();
  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  timer.unref?.();

  return {
    close() {
      clearTimeout(bootTimer);
      clearInterval(timer);
    },
  };
}
