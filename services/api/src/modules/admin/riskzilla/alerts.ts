// /admin/riskzilla/alerts — the alert center (migration 20260906T230248).
//
// Queue of risk signals with a ticket lifecycle: open -> acknowledged
// -> resolved, an assignee, and an event trail (comments, hand-offs).
// Rows are produced by lib/riskzilla/alert-sweeper.ts from the rules in
// risk_alert_rules; this module reads the queue and records what the
// desk does with it. Every mutation writes risk_alert_events AND
// admin_audit_log (action riskzilla.alert.*), so the tamper-evident
// chain covers alert handling too.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { adminAuditLog } from "@oddzilla/db";
import { BadRequestError, NotFoundError } from "../../../lib/errors.js";
import {
  ALERT_RULES,
  ALERT_RULE_BY_KIND,
  ALERT_SEVERITIES,
  readParams,
} from "../../../lib/riskzilla/alert-rules.js";
import { runAlertSweep } from "../../../lib/riskzilla/alert-sweeper.js";

const SEVERITY = z.enum(ALERT_SEVERITIES);
const KINDS = ALERT_RULES.map((r) => r.kind) as [string, ...string[]];

const listQuery = z.object({
  // active = open + acknowledged (the working queue).
  status: z.enum(["active", "open", "acknowledged", "resolved", "all"]).default("active"),
  severity: SEVERITY.optional(),
  kind: z.enum(KINDS).optional(),
  userId: z.string().uuid().optional(),
  // "me" resolves to the calling admin.
  assignee: z.union([z.literal("me"), z.literal("unassigned"), z.string().uuid()]).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const idParam = z.object({ id: z.string().regex(/^\d+$/) });

interface RawAlert {
  id: string;
  kind: string;
  severity: string;
  status: string;
  title: string;
  body: string | null;
  dedupe_key: string;
  subject_user_id: string | null;
  subject_email: string | null;
  subject_nickname: string | null;
  subject_labels: string[] | null;
  ticket_id: string | null;
  match_id: string | null;
  match_label: string | null;
  currency: string | null;
  amount_micro: string | null;
  payload: unknown;
  assigned_to: string | null;
  assignee_email: string | null;
  acknowledged_at: Date | string | null;
  acknowledged_by: string | null;
  acknowledged_by_email: string | null;
  resolved_at: Date | string | null;
  resolved_by: string | null;
  resolved_by_email: string | null;
  resolution: string | null;
  occurrences: number;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  comment_count: number;
}

function iso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toDto(r: RawAlert) {
  return {
    id: r.id,
    kind: r.kind,
    kindLabel: ALERT_RULE_BY_KIND[r.kind]?.label ?? r.kind,
    severity: r.severity,
    status: r.status,
    title: r.title,
    body: r.body,
    subjectUserId: r.subject_user_id,
    subjectEmail: r.subject_email,
    subjectNickname: r.subject_nickname,
    subjectLabels: r.subject_labels ?? [],
    ticketId: r.ticket_id,
    matchId: r.match_id,
    matchLabel: r.match_label,
    currency: r.currency?.trim() ?? null,
    amountMicro: r.amount_micro,
    payload: r.payload ?? {},
    assignedTo: r.assigned_to,
    assigneeEmail: r.assignee_email,
    acknowledgedAt: iso(r.acknowledged_at),
    acknowledgedBy: r.acknowledged_by,
    acknowledgedByEmail: r.acknowledged_by_email,
    resolvedAt: iso(r.resolved_at),
    resolvedBy: r.resolved_by,
    resolvedByEmail: r.resolved_by_email,
    resolution: r.resolution,
    occurrences: Number(r.occurrences),
    firstSeenAt: iso(r.first_seen_at)!,
    lastSeenAt: iso(r.last_seen_at)!,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    commentCount: Number(r.comment_count ?? 0),
  };
}

// Built per call (not a top-level const) per the repo's Drizzle lint rule;
// it carries no bind parameters, the callers append their own WHERE.
const alertSelect = () => sql`
  SELECT
    a.id::text                    AS id,
    a.kind, a.severity::text      AS severity,
    a.status::text                AS status,
    a.title, a.body, a.dedupe_key,
    a.subject_user_id::text       AS subject_user_id,
    su.email                      AS subject_email,
    su.nickname                   AS subject_nickname,
    su.labels                     AS subject_labels,
    a.ticket_id::text             AS ticket_id,
    a.match_id::text              AS match_id,
    CASE WHEN m.id IS NOT NULL THEN m.home_team || ' vs ' || m.away_team END AS match_label,
    a.currency,
    a.amount_micro::text          AS amount_micro,
    a.payload,
    a.assigned_to::text           AS assigned_to,
    asg.email                     AS assignee_email,
    a.acknowledged_at,
    a.acknowledged_by::text       AS acknowledged_by,
    ack.email                     AS acknowledged_by_email,
    a.resolved_at,
    a.resolved_by::text           AS resolved_by,
    res.email                     AS resolved_by_email,
    a.resolution, a.occurrences, a.first_seen_at, a.last_seen_at,
    a.created_at, a.updated_at,
    (SELECT COUNT(*)::int FROM risk_alert_events e
      WHERE e.alert_id = a.id AND e.kind = 'comment') AS comment_count
  FROM risk_alerts a
  LEFT JOIN users su  ON su.id  = a.subject_user_id
  LEFT JOIN users asg ON asg.id = a.assigned_to
  LEFT JOIN users ack ON ack.id = a.acknowledged_by
  LEFT JOIN users res ON res.id = a.resolved_by
  LEFT JOIN matches m ON m.id = a.match_id
`;

async function summary(app: FastifyInstance, adminId: string) {
  const rows = (await app.db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status <> 'resolved' AND severity = 'critical')::int AS critical,
      COUNT(*) FILTER (WHERE status <> 'resolved' AND severity = 'serious')::int  AS serious,
      COUNT(*) FILTER (WHERE status <> 'resolved' AND severity = 'warning')::int  AS warning,
      COUNT(*) FILTER (WHERE status = 'open')::int                                AS open,
      COUNT(*) FILTER (WHERE status = 'acknowledged')::int                        AS acknowledged,
      COUNT(*) FILTER (WHERE status <> 'resolved' AND assigned_to = ${adminId}::uuid)::int AS assigned_to_me,
      COUNT(*) FILTER (WHERE status = 'resolved' AND resolved_at >= NOW() - interval '24 hours')::int AS resolved_24h
    FROM risk_alerts
  `)) as unknown as Array<Record<string, number>>;
  const r = rows[0] ?? {};
  const critical = Number(r.critical ?? 0);
  const serious = Number(r.serious ?? 0);
  const warning = Number(r.warning ?? 0);
  return {
    critical,
    serious,
    warning,
    active: critical + serious + warning,
    open: Number(r.open ?? 0),
    acknowledged: Number(r.acknowledged ?? 0),
    assignedToMe: Number(r.assigned_to_me ?? 0),
    resolved24h: Number(r.resolved_24h ?? 0),
  };
}

async function loadOne(app: FastifyInstance, id: string) {
  const rows = (await app.db.execute(sql`${alertSelect()} WHERE a.id = ${id}::bigint`)) as unknown as RawAlert[];
  const row = rows[0];
  if (!row) throw new NotFoundError("alert_not_found", "alert_not_found");
  return row;
}

export default async function riskzillaAlertsRoutes(app: FastifyInstance) {
  app.get("/admin/riskzilla/alerts/summary", async (request) => {
    const admin = request.requireRole("admin");
    return summary(app, admin.id);
  });

  app.get("/admin/riskzilla/alerts/rules", async (request) => {
    request.requireRole("admin");
    const rows = (await app.db.execute(sql`
      SELECT r.kind, r.enabled, r.severity::text AS severity, r.params, r.updated_at,
             u.email AS updated_by_email,
             (SELECT COUNT(*)::int FROM risk_alerts a
               WHERE a.kind = r.kind AND a.status <> 'resolved') AS active_count
        FROM risk_alert_rules r
        LEFT JOIN users u ON u.id = r.updated_by
    `)) as unknown as Array<{
      kind: string;
      enabled: boolean;
      severity: string;
      params: unknown;
      updated_at: Date | string;
      updated_by_email: string | null;
      active_count: number;
    }>;
    const stored = new Map(rows.map((r) => [r.kind, r]));
    return {
      rules: ALERT_RULES.map((def) => {
        const row = stored.get(def.kind);
        return {
          kind: def.kind,
          label: def.label,
          description: def.description,
          seeded: Boolean(row),
          enabled: row?.enabled ?? false,
          severity: row?.severity ?? def.defaultSeverity,
          params: readParams(def, row?.params),
          defaultParams: def.defaultParams,
          paramMeta: def.paramMeta,
          activeCount: Number(row?.active_count ?? 0),
          updatedAt: row ? iso(row.updated_at) : null,
          updatedByEmail: row?.updated_by_email ?? null,
        };
      }),
    };
  });

  app.put("/admin/riskzilla/alerts/rules/:kind", async (request) => {
    const admin = request.requireRole("admin");
    const { kind } = z.object({ kind: z.enum(KINDS) }).parse(request.params);
    const def = ALERT_RULE_BY_KIND[kind]!;
    const body = z
      .object({
        enabled: z.boolean(),
        severity: SEVERITY,
        params: z.record(z.string(), z.number().finite()).default({}),
      })
      .parse(request.body);
    for (const key of Object.keys(body.params)) {
      if (!def.paramMeta[key]) {
        throw new BadRequestError(`unknown_param:${key}`, "unknown_param");
      }
    }
    const params = readParams(def, body.params);

    const beforeRows = (await app.db.execute(sql`
      SELECT enabled, severity::text AS severity, params FROM risk_alert_rules WHERE kind = ${kind}
    `)) as unknown as Array<{ enabled: boolean; severity: string; params: unknown }>;
    const before = beforeRows[0]
      ? {
          enabled: beforeRows[0].enabled,
          severity: beforeRows[0].severity,
          params: readParams(def, beforeRows[0].params),
        }
      : null;

    await app.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO risk_alert_rules (kind, enabled, severity, params, updated_by, updated_at)
        VALUES (${kind}::text, ${body.enabled}, ${body.severity}::risk_alert_severity,
                ${JSON.stringify(params)}::jsonb, ${admin.id}::uuid, NOW())
        ON CONFLICT (kind) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          severity = EXCLUDED.severity,
          params = EXCLUDED.params,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
      `);
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: "riskzilla.alert_rule.update",
        targetType: "risk_alert_rule",
        targetId: kind,
        beforeJson: before ?? {},
        afterJson: { enabled: body.enabled, severity: body.severity, params },
        ipInet: request.ip ?? null,
      });
    });
    return { ok: true, kind, enabled: body.enabled, severity: body.severity, params };
  });

  // Run the sweep right now — for the desk after tuning a threshold, and
  // for local stacks where waiting a minute is a nuisance.
  app.post("/admin/riskzilla/alerts/sweep", async (request) => {
    request.requireRole("admin");
    return runAlertSweep(app.db, app.log);
  });

  app.get("/admin/riskzilla/alerts", async (request) => {
    const admin = request.requireRole("admin");
    const q = listQuery.parse(request.query);

    const conditions: ReturnType<typeof sql>[] = [];
    switch (q.status) {
      case "active":
        conditions.push(sql`a.status <> 'resolved'`);
        break;
      case "all":
        break;
      default:
        conditions.push(sql`a.status = ${q.status}::risk_alert_status`);
    }
    if (q.severity) conditions.push(sql`a.severity = ${q.severity}::risk_alert_severity`);
    if (q.kind) conditions.push(sql`a.kind = ${q.kind}`);
    if (q.userId) conditions.push(sql`a.subject_user_id = ${q.userId}::uuid`);
    if (q.assignee === "me") conditions.push(sql`a.assigned_to = ${admin.id}::uuid`);
    else if (q.assignee === "unassigned") conditions.push(sql`a.assigned_to IS NULL`);
    else if (q.assignee) conditions.push(sql`a.assigned_to = ${q.assignee}::uuid`);
    if (q.q) {
      const like = `%${q.q.replace(/[%_]/g, "")}%`;
      conditions.push(sql`(
        a.title ILIKE ${like} OR a.body ILIKE ${like}
        OR EXISTS (SELECT 1 FROM users uq WHERE uq.id = a.subject_user_id
                     AND (uq.email ILIKE ${like} OR uq.nickname ILIKE ${like}))
        OR a.ticket_id::text = ${q.q}
      )`);
    }
    const where =
      conditions.length === 0
        ? sql``
        : sql`WHERE ${conditions.reduce((acc, c, i) => (i === 0 ? c : sql`${acc} AND ${c}`))}`;

    const [rows, totalRows, counts] = await Promise.all([
      app.db.execute(sql`
        ${alertSelect()}
        ${where}
        ORDER BY
          CASE WHEN a.status = 'resolved' THEN 1 ELSE 0 END,
          CASE a.severity WHEN 'critical' THEN 0 WHEN 'serious' THEN 1 ELSE 2 END,
          a.last_seen_at DESC, a.id DESC
        LIMIT ${q.limit} OFFSET ${q.offset}
      `) as unknown as Promise<RawAlert[]>,
      app.db.execute(sql`SELECT COUNT(*)::int AS total FROM risk_alerts a ${where}`) as unknown as Promise<
        Array<{ total: number }>
      >,
      summary(app, admin.id),
    ]);

    return {
      entries: rows.map(toDto),
      total: Number(totalRows[0]?.total ?? 0),
      limit: q.limit,
      offset: q.offset,
      counts,
    };
  });

  app.get("/admin/riskzilla/alerts/:id", async (request) => {
    request.requireRole("admin");
    const { id } = idParam.parse(request.params);
    const row = await loadOne(app, id);
    const events = (await app.db.execute(sql`
      SELECT e.id::text AS id, e.kind, e.note, e.meta, e.created_at,
             e.actor_user_id::text AS actor_user_id, u.email AS actor_email
        FROM risk_alert_events e
        LEFT JOIN users u ON u.id = e.actor_user_id
       WHERE e.alert_id = ${id}::bigint
       ORDER BY e.id ASC
    `)) as unknown as Array<{
      id: string;
      kind: string;
      note: string | null;
      meta: unknown;
      created_at: Date | string;
      actor_user_id: string | null;
      actor_email: string | null;
    }>;
    return {
      alert: toDto(row),
      events: events.map((e) => ({
        id: e.id,
        kind: e.kind,
        note: e.note,
        meta: e.meta ?? {},
        actorUserId: e.actor_user_id,
        actorEmail: e.actor_email,
        createdAt: iso(e.created_at)!,
      })),
    };
  });

  // ── Lifecycle actions ────────────────────────────────────────────────

  async function transition(
    request: FastifyRequest,
    id: string,
    opts: {
      action: string;
      eventKind: string;
      note?: string | null;
      meta?: Record<string, unknown>;
      apply: (adminId: string) => ReturnType<typeof sql>;
      allowed: (status: string) => boolean;
    },
  ) {
    const admin = request.requireRole("admin");
    const before = await loadOne(app, id);
    if (!opts.allowed(before.status)) {
      throw new BadRequestError(`invalid_transition_from_${before.status}`, "invalid_transition");
    }
    await app.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE risk_alerts SET ${opts.apply(admin.id)}, updated_at = NOW()
         WHERE id = ${id}::bigint
      `);
      await tx.execute(sql`
        INSERT INTO risk_alert_events (alert_id, kind, actor_user_id, note, meta)
        VALUES (${id}::bigint, ${opts.eventKind}::text, ${admin.id}::uuid,
                ${opts.note ?? null}::text, ${JSON.stringify(opts.meta ?? {})}::jsonb)
      `);
      await tx.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: opts.action,
        targetType: "risk_alert",
        targetId: id,
        subjectUserId: before.subject_user_id,
        beforeJson: { status: before.status, assignedTo: before.assigned_to },
        afterJson: { event: opts.eventKind, note: opts.note ?? null, ...(opts.meta ?? {}) },
        ipInet: request.ip ?? null,
      });
    });
    const after = await loadOne(app, id);
    return { alert: toDto(after) };
  }

  app.post("/admin/riskzilla/alerts/:id/acknowledge", async (request) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ note: z.string().trim().max(2000).optional() }).parse(request.body ?? {});
    return transition(request, id, {
      action: "riskzilla.alert.acknowledge",
      eventKind: "acknowledged",
      note: body.note || null,
      allowed: (s) => s === "open",
      apply: (adminId) => sql`
        status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = ${adminId}::uuid,
        assigned_to = COALESCE(assigned_to, ${adminId}::uuid)
      `,
    });
  });

  app.post("/admin/riskzilla/alerts/:id/assign", async (request) => {
    const { id } = idParam.parse(request.params);
    const body = z
      .object({ assigneeId: z.union([z.literal("me"), z.string().uuid()]).nullable() })
      .parse(request.body);
    const admin = request.requireRole("admin");
    const target = body.assigneeId === "me" ? admin.id : body.assigneeId;
    if (target) {
      const rows = (await app.db.execute(sql`
        SELECT 1 FROM users WHERE id = ${target}::uuid AND role IN ('admin', 'support')
      `)) as unknown as unknown[];
      if (rows.length === 0) throw new BadRequestError("assignee_not_staff", "assignee_not_staff");
    }
    return transition(request, id, {
      action: "riskzilla.alert.assign",
      eventKind: "assigned",
      meta: { assigneeId: target },
      allowed: (s) => s !== "resolved",
      apply: () => (target ? sql`assigned_to = ${target}::uuid` : sql`assigned_to = NULL`),
    });
  });

  app.post("/admin/riskzilla/alerts/:id/comment", async (request) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ note: z.string().trim().min(1).max(2000) }).parse(request.body);
    return transition(request, id, {
      action: "riskzilla.alert.comment",
      eventKind: "comment",
      note: body.note,
      allowed: () => true,
      apply: () => sql`updated_at = NOW()`,
    });
  });

  app.post("/admin/riskzilla/alerts/:id/resolve", async (request) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ note: z.string().trim().max(2000).optional() }).parse(request.body ?? {});
    return transition(request, id, {
      action: "riskzilla.alert.resolve",
      eventKind: "resolved",
      note: body.note || null,
      allowed: (s) => s !== "resolved",
      apply: (adminId) => sql`
        status = 'resolved', resolved_at = NOW(), resolved_by = ${adminId}::uuid,
        resolution = ${body.note || null}::text,
        acknowledged_at = COALESCE(acknowledged_at, NOW()),
        acknowledged_by = COALESCE(acknowledged_by, ${adminId}::uuid)
      `,
    });
  });

  app.post("/admin/riskzilla/alerts/:id/reopen", async (request) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ note: z.string().trim().max(2000).optional() }).parse(request.body ?? {});
    // Reopening collides with the partial unique index if the sweeper
    // has since raised the same condition again under the same key —
    // surface that as a clean 400 instead of a 500.
    const before = await loadOne(app, id);
    const dup = (await app.db.execute(sql`
      SELECT 1 FROM risk_alerts WHERE dedupe_key = ${before.dedupe_key} AND status <> 'resolved' AND id <> ${id}::bigint
    `)) as unknown as unknown[];
    if (dup.length > 0) {
      throw new BadRequestError("newer_alert_open_for_same_condition", "duplicate_active_alert");
    }
    return transition(request, id, {
      action: "riskzilla.alert.reopen",
      eventKind: "reopened",
      note: body.note || null,
      allowed: (s) => s === "resolved",
      apply: () => sql`
        status = 'acknowledged', resolved_at = NULL, resolved_by = NULL, resolution = NULL
      `,
    });
  });
}
