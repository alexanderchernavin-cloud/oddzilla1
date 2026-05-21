// /admin/emails — backoffice inbox + compose + reply.
//
// Surface area:
//   GET    /admin/emails/threads         list inbox (paginated, filters)
//   GET    /admin/emails/threads/:id     thread detail (messages interleaved)
//   POST   /admin/emails/threads/:id/reply
//   POST   /admin/emails/threads/:id/archive
//   POST   /admin/emails/threads/:id/unarchive
//   POST   /admin/emails/threads/:id/mark-read
//   POST   /admin/emails/compose         new outbound thread
//   GET    /admin/emails/unread-count    sidebar badge poll
//
// Outbound writes land in email_outbox with kind=admin_outbound (new
// thread) or admin_reply (within existing thread). The worker picks
// them up via LISTEN/NOTIFY and dispatches through Resend.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  emailInbound,
  emailOutbox,
  emailThreads,
  adminAuditLog,
  users,
} from "@oddzilla/db";
import { sql as dsql } from "drizzle-orm";
import { loadEnv } from "@oddzilla/config";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import { normaliseSubject } from "../email/inbound/threading.js";

const writeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  filter: z.enum(["inbox", "archived", "unread", "all"]).default("inbox"),
  q: z.string().trim().max(200).optional(),
});

const replyBody = z.object({
  textBody: z.string().min(1).max(50_000),
  htmlBody: z.string().max(200_000).nullable().optional(),
});

const composeBody = z.object({
  to: z.string().email().max(320),
  subject: z.string().min(1).max(998),
  textBody: z.string().min(1).max(50_000),
  htmlBody: z.string().max(200_000).nullable().optional(),
});

interface ThreadSummary {
  id: string;
  subject: string;
  firstFrom: string | null;
  firstTo: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  inboundCount: number;
  outboundCount: number;
  unreadInbound: number;
  archived: boolean;
  preview: string | null;
}

interface ThreadMessage {
  direction: "inbound" | "outbound";
  id: string;
  who: string;
  whoName: string | null;
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  ts: string;
  status: "received" | "queued" | "sent" | "failed";
  attachments?: Array<{ filename: string; contentType: string | null; sizeBytes: number }>;
  spamScore?: number | null;
}

export default async function adminEmailRoutes(app: FastifyInstance) {
  // ─── Inbox list ────────────────────────────────────────────────────────
  app.get(
    "/admin/emails/threads",
    async (request): Promise<{ threads: ThreadSummary[]; nextCursor: string | null }> => {
      request.requireRole("admin");
      const q = listQuery.parse(request.query);

      // Cursor = last activity timestamp + thread id, base64-encoded so
      // it round-trips opaquely.
      let cursorActivity: Date | null = null;
      let cursorId: string | null = null;
      if (q.cursor) {
        try {
          const decoded = Buffer.from(q.cursor, "base64url").toString("utf8");
          const [ts, id] = decoded.split("|");
          if (ts && id) {
            cursorActivity = new Date(ts);
            cursorId = id;
          }
        } catch {
          // Bad cursor — ignore, return first page.
        }
      }

      const filters: ReturnType<typeof sql>[] = [];
      if (q.filter === "inbox") {
        filters.push(sql`${emailThreads.archivedAt} IS NULL`);
      } else if (q.filter === "archived") {
        filters.push(sql`${emailThreads.archivedAt} IS NOT NULL`);
      } else if (q.filter === "unread") {
        filters.push(sql`${emailThreads.archivedAt} IS NULL`);
        filters.push(
          sql`EXISTS (
            SELECT 1 FROM ${emailInbound}
             WHERE ${emailInbound.threadId} = ${emailThreads.id}
               AND ${emailInbound.readAt} IS NULL
          )`,
        );
      }
      if (q.q) {
        const pattern = `%${q.q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
        filters.push(
          sql`(${emailThreads.subject} ILIKE ${pattern} OR ${emailThreads.firstFrom} ILIKE ${pattern})`,
        );
      }
      if (cursorActivity && cursorId) {
        filters.push(
          sql`(GREATEST(COALESCE(${emailThreads.lastInboundAt}, ${emailThreads.createdAt}),
                       COALESCE(${emailThreads.lastOutboundAt}, ${emailThreads.createdAt})), ${emailThreads.id}::text)
              < (${cursorActivity.toISOString()}::timestamptz, ${cursorId})`,
        );
      }

      const whereClause = filters.length > 0
        ? filters.reduce((acc, c, i) => (i === 0 ? c : sql`${acc} AND ${c}`))
        : sql`TRUE`;

      const rows = await app.db.execute<{
        id: string;
        subject: string;
        first_from: string | null;
        first_to: string | null;
        last_inbound_at: Date | null;
        last_outbound_at: Date | null;
        inbound_count: number;
        outbound_count: number;
        archived_at: Date | null;
        unread_inbound: number;
        preview: string | null;
        activity_ts: Date;
      }>(sql`
        SELECT
          t.id::text,
          t.subject,
          t.first_from,
          t.first_to,
          t.last_inbound_at,
          t.last_outbound_at,
          t.inbound_count,
          t.outbound_count,
          t.archived_at,
          COALESCE(unread.cnt, 0) AS unread_inbound,
          preview.body AS preview,
          GREATEST(COALESCE(t.last_inbound_at, t.created_at),
                   COALESCE(t.last_outbound_at, t.created_at)) AS activity_ts
        FROM email_threads t
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS cnt
            FROM email_inbound
           WHERE thread_id = t.id AND read_at IS NULL
        ) unread ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(NULLIF(LEFT(text_body, 240), ''), LEFT(subject, 240)) AS body
            FROM email_inbound
           WHERE thread_id = t.id
           ORDER BY received_at DESC
           LIMIT 1
        ) preview ON true
        WHERE ${whereClause}
        ORDER BY activity_ts DESC, t.id DESC
        LIMIT ${q.limit + 1}
      `);

      const trimmed = rows.slice(0, q.limit);
      const hasMore = rows.length > q.limit;
      const nextCursor = hasMore
        ? Buffer.from(
            `${rows[q.limit - 1]!.activity_ts.toISOString()}|${rows[q.limit - 1]!.id}`,
          ).toString("base64url")
        : null;

      return {
        threads: trimmed.map((r) => ({
          id: r.id,
          subject: r.subject,
          firstFrom: r.first_from,
          firstTo: r.first_to,
          lastInboundAt: r.last_inbound_at ? r.last_inbound_at.toISOString() : null,
          lastOutboundAt: r.last_outbound_at ? r.last_outbound_at.toISOString() : null,
          inboundCount: r.inbound_count,
          outboundCount: r.outbound_count,
          unreadInbound: r.unread_inbound,
          archived: r.archived_at !== null,
          preview: r.preview,
        })),
        nextCursor,
      };
    },
  );

  // ─── Thread detail ─────────────────────────────────────────────────────
  app.get(
    "/admin/emails/threads/:id",
    async (
      request,
    ): Promise<{ thread: ThreadSummary; messages: ThreadMessage[] }> => {
      request.requireRole("admin");
      const id = (request.params as { id?: string }).id ?? "";
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError("thread_not_found", "thread_not_found");

      const [thread] = await app.db
        .select()
        .from(emailThreads)
        .where(eq(emailThreads.id, id))
        .limit(1);
      if (!thread) throw new NotFoundError("thread_not_found", "thread_not_found");

      const inboundRows = await app.db
        .select()
        .from(emailInbound)
        .where(eq(emailInbound.threadId, id));

      const outboundRows = await app.db
        .select()
        .from(emailOutbox)
        .where(and(eq(emailOutbox.threadId, id)));

      const messages: ThreadMessage[] = [
        ...inboundRows.map<ThreadMessage>((r) => ({
          direction: "inbound",
          id: r.id,
          who: r.fromAddress,
          whoName: r.fromName,
          subject: r.subject,
          textBody: r.textBody,
          htmlBody: r.htmlBody,
          ts: r.receivedAt.toISOString(),
          status: "received",
          attachments: (r.attachmentsMeta as Array<{
            filename: string;
            contentType: string | null;
            sizeBytes: number;
          }>) ?? [],
          spamScore: r.spamScore !== null ? Number(r.spamScore) : null,
        })),
        ...outboundRows.map<ThreadMessage>((r) => ({
          direction: "outbound",
          id: String(r.id),
          who: r.toAddress,
          whoName: null,
          subject: r.subject,
          textBody: r.textBody,
          htmlBody: r.htmlBody,
          ts: (r.sentAt ?? r.enqueuedAt).toISOString(),
          status: r.sentAt
            ? r.lastError && r.lastError !== "email_disabled"
              ? "failed"
              : "sent"
            : "queued",
        })),
      ].sort((a, b) => a.ts.localeCompare(b.ts));

      const unreadInbound = inboundRows.filter((r) => r.readAt === null).length;
      const lastInboundForPreview = inboundRows
        .slice()
        .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())[0];

      const summary: ThreadSummary = {
        id: thread.id,
        subject: thread.subject,
        firstFrom: thread.firstFrom,
        firstTo: thread.firstTo,
        lastInboundAt: thread.lastInboundAt ? thread.lastInboundAt.toISOString() : null,
        lastOutboundAt: thread.lastOutboundAt ? thread.lastOutboundAt.toISOString() : null,
        inboundCount: thread.inboundCount,
        outboundCount: thread.outboundCount,
        unreadInbound,
        archived: thread.archivedAt !== null,
        preview: lastInboundForPreview
          ? (lastInboundForPreview.textBody ?? lastInboundForPreview.subject).slice(0, 240)
          : null,
      };

      return { thread: summary, messages };
    },
  );

  // ─── Reply ─────────────────────────────────────────────────────────────
  app.post(
    "/admin/emails/threads/:id/reply",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const id = (request.params as { id?: string }).id ?? "";
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError("thread_not_found", "thread_not_found");
      const body = replyBody.parse(request.body);

      const [thread] = await app.db
        .select()
        .from(emailThreads)
        .where(eq(emailThreads.id, id))
        .limit(1);
      if (!thread) throw new NotFoundError("thread_not_found", "thread_not_found");

      // Pick the recipient: the most recent inbound message's
      // from_address, falling back to firstFrom. Replying always goes
      // back to whoever last wrote.
      const [latestInbound] = await app.db
        .select({
          fromAddress: emailInbound.fromAddress,
          messageId: emailInbound.messageId,
        })
        .from(emailInbound)
        .where(eq(emailInbound.threadId, id))
        .orderBy(desc(emailInbound.receivedAt))
        .limit(1);

      const to = latestInbound?.fromAddress ?? thread.firstFrom;
      if (!to) {
        throw new BadRequestError("no_recipient", "no_recipient");
      }

      const subject = thread.subject.match(/^\s*(re|fwd?):/i)
        ? thread.subject
        : `Re: ${thread.subject}`;

      await app.db.transaction(async (tx) => {
        await tx.insert(emailOutbox).values({
          kind: "admin_reply",
          userId: null,
          toAddress: to,
          subject,
          payload: { from: "admin_reply", adminId: admin.id },
          textBody: body.textBody,
          htmlBody: body.htmlBody ?? null,
          threadId: id,
          inReplyTo: latestInbound?.messageId ?? null,
        });
        await tx.execute(dsql`SELECT pg_notify('email_outbox', '')`);

        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "email_reply",
          targetType: "email_thread",
          targetId: id,
          beforeJson: {},
          afterJson: { to, subject, len: body.textBody.length },
        });
      });

      return { ok: true };
    },
  );

  // ─── Archive / unarchive ──────────────────────────────────────────────
  for (const [path, archive] of [
    ["/admin/emails/threads/:id/archive", true],
    ["/admin/emails/threads/:id/unarchive", false],
  ] as const) {
    app.post(path, { config: writeRateLimit }, async (request) => {
      const admin = request.requireRole("admin");
      const id = (request.params as { id?: string }).id ?? "";
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError("thread_not_found", "thread_not_found");

      const [updated] = await app.db
        .update(emailThreads)
        .set({ archivedAt: archive ? new Date() : null })
        .where(eq(emailThreads.id, id))
        .returning({ id: emailThreads.id });
      if (!updated) throw new NotFoundError("thread_not_found", "thread_not_found");

      await app.db.insert(adminAuditLog).values({
        actorUserId: admin.id,
        action: archive ? "email_thread_archive" : "email_thread_unarchive",
        targetType: "email_thread",
        targetId: id,
        beforeJson: {},
        afterJson: {},
      });
      return { ok: true };
    });
  }

  // ─── Mark read ─────────────────────────────────────────────────────────
  app.post(
    "/admin/emails/threads/:id/mark-read",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("admin");
      const id = (request.params as { id?: string }).id ?? "";
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError("thread_not_found", "thread_not_found");

      const updated = await app.db
        .update(emailInbound)
        .set({ readAt: new Date(), readByUserId: admin.id })
        .where(and(eq(emailInbound.threadId, id), isNull(emailInbound.readAt)))
        .returning({ id: emailInbound.id });
      return { ok: true, marked: updated.length };
    },
  );

  // ─── Compose (new thread) ─────────────────────────────────────────────
  app.post(
    "/admin/emails/compose",
    { config: writeRateLimit },
    async (request): Promise<{ threadId: string }> => {
      const admin = request.requireRole("admin");
      const body = composeBody.parse(request.body);
      const env = loadEnv();

      const normalised = normaliseSubject(body.subject) || body.subject.toLowerCase();
      const result = await app.db.transaction(async (tx) => {
        const [thread] = await tx
          .insert(emailThreads)
          .values({
            subject: body.subject,
            normalisedSubject: normalised,
            firstFrom: env.EMAIL_FROM,
            firstTo: body.to,
          })
          .returning({ id: emailThreads.id });
        if (!thread) throw new Error("thread insert returned no row");

        await tx.insert(emailOutbox).values({
          kind: "admin_outbound",
          userId: null,
          toAddress: body.to,
          subject: body.subject,
          payload: { from: "admin_compose", adminId: admin.id },
          textBody: body.textBody,
          htmlBody: body.htmlBody ?? null,
          threadId: thread.id,
        });
        await tx.execute(dsql`SELECT pg_notify('email_outbox', '')`);

        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "email_compose",
          targetType: "email_thread",
          targetId: thread.id,
          beforeJson: {},
          afterJson: { to: body.to, subject: body.subject, len: body.textBody.length },
        });
        return thread.id;
      });

      return { threadId: result };
    },
  );

  // ─── Unread badge count ───────────────────────────────────────────────
  // Polled by the admin sidebar at 60 s cadence. Cheap aggregate query
  // — the unread partial index makes this a tiny scan.
  app.get(
    "/admin/emails/unread-count",
    async (request): Promise<{ unread: number; threads: number }> => {
      request.requireRole("admin");
      const [row] = await app.db.execute<{ unread: number; threads: number }>(sql`
        SELECT COUNT(*)::int AS unread,
               COUNT(DISTINCT thread_id)::int AS threads
          FROM email_inbound
         WHERE read_at IS NULL
      `);
      return { unread: row?.unread ?? 0, threads: row?.threads ?? 0 };
    },
  );

  // Suppress unused-import warnings for symbols only referenced in
  // type positions when the type-checker is in strict-unused mode.
  void users;
  void isNotNull;
}
