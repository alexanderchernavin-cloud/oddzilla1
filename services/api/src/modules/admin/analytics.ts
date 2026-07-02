// Admin read surface for the first-party FE analytics pipeline
// (see services/api/src/modules/analytics/routes.ts for the intake).
// Read-only — no admin_audit_log rows needed.

import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type {
  AdminAnalyticsMouseTrail,
  AdminAnalyticsOverview,
  AdminAnalyticsSessionDetail,
  AdminAnalyticsSessionSummary,
} from "@oddzilla/types";
import { NotFoundError } from "../../lib/errors.js";

const daysSchema = z.coerce.number().int().min(1).max(90).default(7);

const overviewQuerySchema = z.object({ days: daysSchema });

const sessionsQuerySchema = z.object({
  days: daysSchema,
  q: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const mouseQuerySchema = z.object({
  path: z.string().min(1).max(300),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Record<string, unknown>;

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  return 0;
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v ?? "");
}

function sessionSummaryFromRow(r: Row): AdminAnalyticsSessionSummary {
  return {
    id: String(r.id),
    userId: r.user_id ? String(r.user_id) : null,
    userEmail: r.email ? String(r.email) : null,
    startedAt: iso(r.started_at),
    lastSeenAt: iso(r.last_seen_at),
    durationSeconds: num(r.duration_seconds),
    entryPath: r.entry_path ? String(r.entry_path) : null,
    exitPath: r.exit_path ? String(r.exit_path) : null,
    pageViewCount: num(r.page_view_count),
    clickCount: num(r.click_count),
    eventCount: num(r.event_count),
    mouseBatchCount: num(r.mouse_batch_count),
  };
}

export async function adminAnalyticsRoutes(app: FastifyInstance) {
  app.get("/admin/analytics/overview", async (request): Promise<AdminAnalyticsOverview> => {
    request.requireRole("admin");
    const { days } = overviewQuerySchema.parse(request.query);

    const [totalsRows, perDayRows, sectionRows, pathRows, clickRows] = await Promise.all([
      app.db.execute(sql`
        SELECT
          COUNT(*)::int AS sessions,
          COUNT(*) FILTER (WHERE user_id IS NOT NULL)::int AS identified_sessions,
          COUNT(DISTINCT user_id)::int AS unique_users,
          COALESCE(SUM(page_view_count), 0)::int AS page_views,
          COALESCE(SUM(click_count), 0)::int AS clicks,
          COALESCE(AVG(EXTRACT(EPOCH FROM (last_seen_at - started_at))), 0)::float8 AS avg_seconds,
          COALESCE(
            PERCENTILE_CONT(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (last_seen_at - started_at))
            ),
            0
          )::float8 AS median_seconds
        FROM analytics_sessions
        WHERE started_at >= now() - make_interval(days => ${days})
      `),
      app.db.execute(sql`
        SELECT
          to_char(date_trunc('day', started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
          COUNT(*)::int AS sessions,
          COALESCE(SUM(page_view_count), 0)::int AS page_views
        FROM analytics_sessions
        WHERE started_at >= now() - make_interval(days => ${days})
        GROUP BY 1
        ORDER BY 1
      `),
      app.db.execute(sql`
        SELECT COALESCE(section, '(unknown)') AS section, COUNT(*)::int AS views
        FROM analytics_events
        WHERE kind = 'page_view'
          AND occurred_at >= now() - make_interval(days => ${days})
        GROUP BY 1
        ORDER BY views DESC
        LIMIT 12
      `),
      app.db.execute(sql`
        SELECT path, COUNT(*)::int AS views
        FROM analytics_events
        WHERE kind = 'page_view'
          AND path IS NOT NULL
          AND occurred_at >= now() - make_interval(days => ${days})
        GROUP BY 1
        ORDER BY views DESC
        LIMIT 15
      `),
      app.db.execute(sql`
        SELECT COALESCE(payload->>'label', '(unknown)') AS label, COUNT(*)::int AS clicks
        FROM analytics_events
        WHERE kind = 'click'
          AND occurred_at >= now() - make_interval(days => ${days})
        GROUP BY 1
        ORDER BY clicks DESC
        LIMIT 15
      `),
    ]);

    const totals = (totalsRows as unknown as Row[])[0] ?? {};
    const sections = (sectionRows as unknown as Row[]).map((r) => ({
      section: String(r.section),
      views: num(r.views),
    }));
    const totalSectionViews = sections.reduce((acc, s) => acc + s.views, 0);

    return {
      rangeDays: days,
      totals: {
        sessions: num(totals.sessions),
        identifiedSessions: num(totals.identified_sessions),
        uniqueUsers: num(totals.unique_users),
        pageViews: num(totals.page_views),
        clicks: num(totals.clicks),
        avgSessionSeconds: Math.round(num(totals.avg_seconds)),
        medianSessionSeconds: Math.round(num(totals.median_seconds)),
      },
      sessionsPerDay: (perDayRows as unknown as Row[]).map((r) => ({
        day: String(r.day),
        sessions: num(r.sessions),
        pageViews: num(r.page_views),
      })),
      topSections: sections.map((s) => ({
        ...s,
        share: totalSectionViews > 0 ? s.views / totalSectionViews : 0,
      })),
      topPaths: (pathRows as unknown as Row[]).map((r) => ({
        path: String(r.path),
        views: num(r.views),
      })),
      topClickTargets: (clickRows as unknown as Row[]).map((r) => ({
        label: String(r.label),
        clicks: num(r.clicks),
      })),
    };
  });

  app.get("/admin/analytics/sessions", async (request) => {
    request.requireRole("admin");
    const query = sessionsQuerySchema.parse(request.query);

    // Keyset cursor: "<startedAtEpochMs>_<sessionId>".
    let cursorClause = sql``;
    if (query.cursor) {
      const [tsRaw, idRaw] = query.cursor.split("_");
      const tsMs = Number(tsRaw);
      if (Number.isFinite(tsMs) && idRaw && UUID_RE.test(idRaw)) {
        const cursorDate = new Date(tsMs);
        cursorClause = sql`AND (s.started_at, s.id) < (${cursorDate}::timestamptz, ${idRaw}::uuid)`;
      }
    }

    let searchClause = sql``;
    if (query.q) {
      if (UUID_RE.test(query.q)) {
        searchClause = sql`AND (s.id = ${query.q}::uuid OR s.user_id = ${query.q}::uuid)`;
      } else {
        searchClause = sql`AND u.email ILIKE ${"%" + query.q + "%"}`;
      }
    }

    const rows = (await app.db.execute(sql`
      SELECT
        s.id, s.user_id, u.email, s.started_at, s.last_seen_at,
        EXTRACT(EPOCH FROM (s.last_seen_at - s.started_at))::int AS duration_seconds,
        s.entry_path, s.exit_path,
        s.page_view_count, s.click_count, s.event_count,
        (SELECT COUNT(*)::int FROM analytics_mouse_batches mb WHERE mb.session_id = s.id)
          AS mouse_batch_count
      FROM analytics_sessions s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.started_at >= now() - make_interval(days => ${query.days})
      ${cursorClause}
      ${searchClause}
      ORDER BY s.started_at DESC, s.id DESC
      LIMIT ${query.limit + 1}
    `)) as unknown as Row[];

    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? `${new Date(iso(last.started_at)).getTime()}_${String(last.id)}`
        : null;

    return {
      sessions: page.map(sessionSummaryFromRow),
      nextCursor,
    };
  });

  app.get("/admin/analytics/sessions/:id", async (request): Promise<AdminAnalyticsSessionDetail> => {
    request.requireRole("admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const [sessionRows, eventRows, mousePathRows] = await Promise.all([
      app.db.execute(sql`
        SELECT
          s.id, s.user_id, u.email, s.started_at, s.last_seen_at,
          EXTRACT(EPOCH FROM (s.last_seen_at - s.started_at))::int AS duration_seconds,
          s.entry_path, s.exit_path, s.referrer, s.user_agent,
          s.viewport_w, s.viewport_h,
          s.page_view_count, s.click_count, s.event_count,
          (SELECT COUNT(*)::int FROM analytics_mouse_batches mb WHERE mb.session_id = s.id)
            AS mouse_batch_count
        FROM analytics_sessions s
        LEFT JOIN users u ON u.id = s.user_id
        WHERE s.id = ${id}
      `),
      app.db.execute(sql`
        SELECT seq, kind, occurred_at, path, section, payload
        FROM analytics_events
        WHERE session_id = ${id}
        ORDER BY seq ASC
        LIMIT 5000
      `),
      app.db.execute(sql`
        SELECT path,
               COUNT(*)::int AS batch_count,
               COALESCE(SUM(point_count), 0)::int AS point_count
        FROM analytics_mouse_batches
        WHERE session_id = ${id}
        GROUP BY path
        ORDER BY MIN(started_at)
      `),
    ]);

    const s = (sessionRows as unknown as Row[])[0];
    if (!s) throw new NotFoundError("Session not found", "session_not_found");

    return {
      session: {
        ...sessionSummaryFromRow(s),
        referrer: s.referrer ? String(s.referrer) : null,
        userAgent: s.user_agent ? String(s.user_agent) : null,
        viewportW: s.viewport_w === null ? null : num(s.viewport_w),
        viewportH: s.viewport_h === null ? null : num(s.viewport_h),
      },
      events: (eventRows as unknown as Row[]).map((r) => ({
        seq: num(r.seq),
        kind: String(r.kind),
        occurredAt: iso(r.occurred_at),
        path: r.path ? String(r.path) : null,
        section: r.section ? String(r.section) : null,
        payload: (r.payload as Record<string, unknown> | null) ?? null,
      })),
      mousePaths: (mousePathRows as unknown as Row[]).map((r) => ({
        path: String(r.path),
        batchCount: num(r.batch_count),
        pointCount: num(r.point_count),
      })),
    };
  });

  app.get("/admin/analytics/sessions/:id/mouse", async (request) => {
    request.requireRole("admin");
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { path } = mouseQuerySchema.parse(request.query);

    const rows = (await app.db.execute(sql`
      SELECT seq, started_at, duration_ms, viewport_w, viewport_h, points
      FROM analytics_mouse_batches
      WHERE session_id = ${id} AND path = ${path}
      ORDER BY seq ASC
      LIMIT 300
    `)) as unknown as Row[];

    const trails: AdminAnalyticsMouseTrail[] = rows.map((r) => ({
      seq: num(r.seq),
      startedAt: iso(r.started_at),
      durationMs: num(r.duration_ms),
      viewportW: r.viewport_w === null ? null : num(r.viewport_w),
      viewportH: r.viewport_h === null ? null : num(r.viewport_h),
      points: (r.points as [number, number, number][]) ?? [],
    }));

    return { trails };
  });
}
