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
  // `sent` = threads with at least one outbound message (admin
  // composed or admin replied). Ordered by last_outbound_at so the
  // Sent view reads chronologically from the operator's perspective.
  filter: z.enum(["inbox", "archived", "unread", "sent", "all"]).default("inbox"),
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
  /** True when at least one outbound message on this thread reached
   * MAX_ATTEMPTS and was force-marked sent with a `max_attempts:` /
   * unsupported_kind error. Surfaced in the inbox row so the operator
   * can see "Send failed" without opening the thread. Successful
   * sends with prior transient errors do NOT trip this (worker clears
   * last_error on success). */
  hasFailedOutbound: boolean;
}

interface ThreadMessage {
  direction: "inbound" | "outbound";
  id: string;
  who: string;
  whoName: string | null;
  /** The recipient address this message was sent to. For inbound mail
   * this is the @oddzilla.cc mailbox it landed in (the MX is a domain
   * catch-all, so the local-part identifies which signup / address the
   * sender used). For outbound it mirrors `who`. */
  toAddress: string | null;
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  ts: string;
  status: "received" | "queued" | "sent" | "failed";
  /** Reason string from email_outbox.last_error when status="failed".
   * Only set for outbound messages that hit a delivery error. */
  failureReason?: string | null;
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

      // IMPORTANT: the FROM clause below aliases email_threads as `t`.
      // Postgres scopes the bare table name OUT once an alias is set,
      // so every filter/order-by reference here must use `t.<column>`,
      // NOT `${emailThreads.<column>}` (which would generate the
      // unaliased `"email_threads"."<column>"` and trip
      // `invalid reference to FROM-clause entry for table "email_threads"`).
      // Caught 2026-05-22 when the operator hit an empty inbox in
      // production despite data being present.
      const filters: ReturnType<typeof sql>[] = [];
      if (q.filter === "inbox") {
        filters.push(sql`t.archived_at IS NULL`);
      } else if (q.filter === "archived") {
        filters.push(sql`t.archived_at IS NOT NULL`);
      } else if (q.filter === "unread") {
        filters.push(sql`t.archived_at IS NULL`);
        filters.push(
          sql`EXISTS (
            SELECT 1 FROM email_inbound
             WHERE thread_id = t.id
               AND read_at IS NULL
          )`,
        );
      } else if (q.filter === "sent") {
        // Threads we've ATTEMPTED to send into — successful AND failed.
        // `outbound_count` only increments on successful delivery, so
        // a `> 0` gate hid dead-letter rows. Operators expect
        // "I clicked Send → it's in Sent" regardless of provider
        // outcome; the row UI surfaces failed status separately.
        filters.push(sql`t.archived_at IS NULL`);
        filters.push(
          sql`EXISTS (
            SELECT 1 FROM email_outbox
             WHERE thread_id = t.id
               AND kind IN ('admin_outbound', 'admin_reply')
          )`,
        );
      }
      if (q.q) {
        const pattern = `%${q.q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
        filters.push(
          sql`(t.subject ILIKE ${pattern} OR t.first_from ILIKE ${pattern})`,
        );
      }
      if (cursorActivity && cursorId) {
        filters.push(
          sql`(GREATEST(COALESCE(t.last_inbound_at, t.created_at),
                       COALESCE(t.last_outbound_at, t.created_at)), t.id::text)
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
        has_failed_outbound: boolean;
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
          -- A dead-letter outbound row: worker gave up after
          -- MAX_ATTEMPTS and stamped sent_at + last_error. Excludes
          -- "email_disabled" (graceful-idle when the provider isn't
          -- configured — not actually a failure, just queued for later).
          EXISTS (
            SELECT 1
              FROM email_outbox
             WHERE thread_id = t.id
               AND kind IN ('admin_outbound', 'admin_reply')
               AND last_error IS NOT NULL
               AND last_error LIKE 'max_attempts:%'
          ) AS has_failed_outbound,
          GREATEST(COALESCE(t.last_inbound_at, t.created_at),
                   COALESCE(t.last_outbound_at, t.created_at)) AS activity_ts
        FROM email_threads t
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS cnt
            FROM email_inbound
           WHERE thread_id = t.id AND read_at IS NULL
        ) unread ON true
        LEFT JOIN LATERAL (
          -- Preview is the most recent message of either direction.
          -- Threads where admin composed but the user hasn't replied
          -- yet would otherwise show no preview at all; union both
          -- sides so the Sent view + brand-new outbound threads
          -- still display useful text.
          SELECT body FROM (
            SELECT received_at AS ts,
                   COALESCE(NULLIF(LEFT(text_body, 240), ''), LEFT(subject, 240)) AS body
              FROM email_inbound
             WHERE thread_id = t.id
            UNION ALL
            SELECT COALESCE(sent_at, enqueued_at) AS ts,
                   COALESCE(NULLIF(LEFT(text_body, 240), ''), LEFT(subject, 240)) AS body
              FROM email_outbox
             WHERE thread_id = t.id
          ) m
          ORDER BY ts DESC NULLS LAST
          LIMIT 1
        ) preview ON true
        WHERE ${whereClause}
        ORDER BY activity_ts DESC, t.id DESC
        LIMIT ${q.limit + 1}
      `);

      // db.execute returns timestamp columns as ISO strings (NOT Date
      // objects) when the SQL is raw `sql\`\`\`` rather than a Drizzle
      // query-builder chain. The TypeScript row-type annotation
      // (Date | null) is misleading — TS doesn't enforce runtime
      // shape. Normalise here so the outbound serialiser is uniform
      // regardless of what the driver returns. Caught after the alias
      // fix landed and the next request 500'd on
      // `r.last_inbound_at.toISOString is not a function`.
      const toIso = (v: Date | string | null | undefined): string | null => {
        if (v == null) return null;
        return typeof v === "string" ? v : v.toISOString();
      };

      const trimmed = rows.slice(0, q.limit);
      const hasMore = rows.length > q.limit;
      const nextCursor = hasMore
        ? Buffer.from(
            `${toIso(rows[q.limit - 1]!.activity_ts)}|${rows[q.limit - 1]!.id}`,
          ).toString("base64url")
        : null;

      return {
        threads: trimmed.map((r) => ({
          id: r.id,
          subject: r.subject,
          firstFrom: r.first_from,
          firstTo: r.first_to,
          lastInboundAt: toIso(r.last_inbound_at),
          lastOutboundAt: toIso(r.last_outbound_at),
          inboundCount: r.inbound_count,
          outboundCount: r.outbound_count,
          unreadInbound: r.unread_inbound,
          archived: r.archived_at !== null,
          preview: r.preview,
          hasFailedOutbound: r.has_failed_outbound,
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
          toAddress: r.toAddress,
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
        ...outboundRows.map<ThreadMessage>((r) => {
          const status: ThreadMessage["status"] = r.sentAt
            ? r.lastError && r.lastError !== "email_disabled"
              ? "failed"
              : "sent"
            : "queued";
          // Strip the `max_attempts:` prefix for display — leaves
          // just the provider-side error string (e.g.
          // `resend_send_failed: status=403 validation_error: …`).
          // Operator-facing copy, not log-level detail.
          let failureReason: string | null = null;
          if (status === "failed" && r.lastError) {
            failureReason = r.lastError.replace(/^max_attempts:/, "");
          }
          return {
            direction: "outbound" as const,
            id: String(r.id),
            who: r.toAddress,
            whoName: null,
            toAddress: r.toAddress,
            subject: r.subject,
            textBody: r.textBody,
            htmlBody: r.htmlBody,
            ts: (r.sentAt ?? r.enqueuedAt).toISOString(),
            status,
            failureReason,
          };
        }),
      ].sort((a, b) => a.ts.localeCompare(b.ts));

      const unreadInbound = inboundRows.filter((r) => r.readAt === null).length;
      const lastInboundForPreview = inboundRows
        .slice()
        .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())[0];

      const hasFailedOutbound = outboundRows.some(
        (r) =>
          (r.kind === "admin_outbound" || r.kind === "admin_reply") &&
          r.lastError !== null &&
          r.lastError.startsWith("max_attempts:"),
      );

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
        hasFailedOutbound,
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
