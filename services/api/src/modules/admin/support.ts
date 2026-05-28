// /admin/support — backoffice inbox for the live support chat.
//
//   GET    /admin/support/threads          list (filters: open/closed/all, q)
//   GET    /admin/support/threads/:id      thread detail with messages
//   POST   /admin/support/threads/:id/reply
//   POST   /admin/support/threads/:id/close
//   POST   /admin/support/threads/:id/reopen
//   POST   /admin/support/threads/:id/mark-read
//   GET    /admin/support/unread-count     sidebar badge poll
//
// Replies fan-out on the bettor's `user:{id}` Redis channel so their
// open browser tabs / mobile widget update without polling. Every
// mutation writes an admin_audit_log row.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  adminAuditLog,
  supportMessages,
  supportThreads,
  users,
} from "@oddzilla/db";
import type {
  AdminSupportThreadDetail,
  AdminSupportThreadSummary,
  AdminSupportUnreadCount,
  SupportMessage,
  SupportMessageFrame,
} from "@oddzilla/types";
import { BadRequestError, NotFoundError } from "../../lib/errors.js";
import {
  mapMessage,
  publishSupportFrame,
  MESSAGE_PAGE_DEFAULT,
} from "../support/shared.js";

const UUID_SHAPE = /^[0-9a-f-]{36}$/i;

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  filter: z.enum(["open", "closed", "unread", "all"]).default("open"),
  q: z.string().trim().max(200).optional(),
});

const replyBody = z.object({
  body: z.string().trim().min(1).max(4000),
});

const writeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

interface ListRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  status: string;
  subject: string | null;
  unread_admin: number;
  unread_user: number;
  last_message_at: Date | string;
  created_at: Date | string;
  closed_at: Date | string | null;
  user_email: string;
  user_nickname: string | null;
  preview: string | null;
}

function toIso(v: Date | string | null | undefined): string {
  if (v == null) return "";
  return typeof v === "string" ? v : v.toISOString();
}

function summarizeListRow(row: ListRow): AdminSupportThreadSummary {
  return {
    id: row.id,
    userId: row.user_id,
    userEmail: row.user_email,
    userNickname: row.user_nickname,
    status: row.status === "closed" ? "closed" : "open",
    subject: row.subject,
    unreadAdmin: row.unread_admin,
    unreadUser: row.unread_user,
    lastMessageAt: toIso(row.last_message_at),
    createdAt: toIso(row.created_at),
    closedAt: row.closed_at ? toIso(row.closed_at) : null,
    preview: row.preview,
  };
}

async function loadAdminDisplayName(
  app: FastifyInstance,
  adminId: string,
): Promise<string | null> {
  const [row] = await app.db
    .select({
      nickname: users.nickname,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, adminId))
    .limit(1);
  if (!row) return null;
  return row.nickname ?? row.displayName ?? null;
}

export default async function adminSupportRoutes(app: FastifyInstance) {
  // ─── Inbox list ────────────────────────────────────────────────────────
  app.get("/admin/support/threads", async (request) => {
    request.requireRole("support");
    const q = listQuery.parse(request.query);

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
        // Bad cursor — first page.
      }
    }

    const filters: ReturnType<typeof sql>[] = [];
    if (q.filter === "open") {
      filters.push(sql`t.status = 'open'`);
    } else if (q.filter === "closed") {
      filters.push(sql`t.status = 'closed'`);
    } else if (q.filter === "unread") {
      filters.push(sql`t.status = 'open' AND t.unread_admin > 0`);
    }
    if (q.q) {
      const pattern = `%${q.q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      filters.push(
        sql`(t.subject ILIKE ${pattern}
             OR u.email::text ILIKE ${pattern}
             OR COALESCE(u.nickname::text, '') ILIKE ${pattern})`,
      );
    }
    if (cursorActivity && cursorId) {
      filters.push(
        sql`(t.last_message_at, t.id::text) < (${cursorActivity.toISOString()}::timestamptz, ${cursorId})`,
      );
    }

    const whereClause =
      filters.length > 0
        ? filters.reduce((acc, c, i) => (i === 0 ? c : sql`${acc} AND ${c}`))
        : sql`TRUE`;

    const rows = await app.db.execute<ListRow>(sql`
      SELECT
        t.id::text,
        t.user_id::text,
        t.status,
        t.subject,
        t.unread_admin,
        t.unread_user,
        t.last_message_at,
        t.created_at,
        t.closed_at,
        u.email::text                 AS user_email,
        u.nickname::text              AS user_nickname,
        preview.body                  AS preview
      FROM support_threads t
      JOIN users u ON u.id = t.user_id
      LEFT JOIN LATERAL (
        SELECT LEFT(body, 240) AS body
          FROM support_messages
         WHERE thread_id = t.id
         ORDER BY id DESC
         LIMIT 1
      ) preview ON true
      WHERE ${whereClause}
      ORDER BY t.last_message_at DESC, t.id DESC
      LIMIT ${q.limit + 1}
    `);

    const trimmed = rows.slice(0, q.limit);
    const hasMore = rows.length > q.limit;
    const last = trimmed[trimmed.length - 1];
    const nextCursor =
      hasMore && last
        ? Buffer.from(`${toIso(last.last_message_at)}|${last.id}`).toString(
            "base64url",
          )
        : null;

    return {
      threads: trimmed.map(summarizeListRow),
      nextCursor,
    };
  });

  // ─── Thread detail ─────────────────────────────────────────────────────
  app.get("/admin/support/threads/:id", async (request): Promise<AdminSupportThreadDetail> => {
    request.requireRole("support");
    const id = (request.params as { id?: string }).id ?? "";
    if (!UUID_SHAPE.test(id)) {
      throw new NotFoundError("thread_not_found", "thread_not_found");
    }

    const detailRows = await app.db.execute<ListRow>(sql`
      SELECT
        t.id::text,
        t.user_id::text,
        t.status,
        t.subject,
        t.unread_admin,
        t.unread_user,
        t.last_message_at,
        t.created_at,
        t.closed_at,
        u.email::text                 AS user_email,
        u.nickname::text              AS user_nickname,
        NULL::text                    AS preview
      FROM support_threads t
      JOIN users u ON u.id = t.user_id
      WHERE t.id = ${id}::uuid
      LIMIT 1
    `);
    const summaryRow = detailRows[0];
    if (!summaryRow) {
      throw new NotFoundError("thread_not_found", "thread_not_found");
    }

    // Author names for operator-side messages so the admin UI doesn't
    // render anonymous "Operator" rows. Bettor / system rows ignore the
    // join. One query joining the small set of senders is cheaper than
    // a per-row lookup.
    const messageRows = await app.db
      .select({
        id: supportMessages.id,
        threadId: supportMessages.threadId,
        senderKind: supportMessages.senderKind,
        senderUserId: supportMessages.senderUserId,
        body: supportMessages.body,
        createdAt: supportMessages.createdAt,
        senderNickname: users.nickname,
        senderDisplayName: users.displayName,
      })
      .from(supportMessages)
      .leftJoin(users, eq(users.id, supportMessages.senderUserId))
      .where(eq(supportMessages.threadId, id))
      .orderBy(asc(supportMessages.id))
      .limit(MESSAGE_PAGE_DEFAULT * 5);

    const messages: SupportMessage[] = messageRows.map((r) => {
      const name =
        r.senderKind === "admin"
          ? r.senderNickname ?? r.senderDisplayName ?? "Support"
          : null;
      return mapMessage(
        {
          id: r.id,
          threadId: r.threadId,
          senderKind: r.senderKind,
          senderUserId: r.senderUserId,
          body: r.body,
          createdAt: r.createdAt,
        },
        name,
      );
    });

    return {
      thread: summarizeListRow(summaryRow),
      messages,
    };
  });

  // ─── Reply ─────────────────────────────────────────────────────────────
  app.post(
    "/admin/support/threads/:id/reply",
    { config: writeRateLimit },
    async (request) => {
      const admin = request.requireRole("support");
      const id = (request.params as { id?: string }).id ?? "";
      if (!UUID_SHAPE.test(id)) {
        throw new NotFoundError("thread_not_found", "thread_not_found");
      }
      const body = replyBody.parse(request.body);

      const result = await app.db.transaction(async (tx) => {
        const [thread] = await tx
          .select()
          .from(supportThreads)
          .where(eq(supportThreads.id, id))
          .for("update")
          .limit(1);
        if (!thread) {
          throw new NotFoundError("thread_not_found", "thread_not_found");
        }
        if (thread.status !== "open") {
          throw new BadRequestError("thread_closed", "thread_closed");
        }

        const [msg] = await tx
          .insert(supportMessages)
          .values({
            threadId: id,
            senderKind: "admin",
            senderUserId: admin.id,
            body: body.body,
          })
          .returning();
        if (!msg) throw new Error("support message insert empty");

        // Bump bettor-side unread + reset admin-side unread in one
        // statement. Operator who replied has implicitly acked any
        // pending bettor messages.
        await tx
          .update(supportThreads)
          .set({
            lastMessageAt: new Date(),
            unreadUser: sql`${supportThreads.unreadUser} + 1`,
            unreadAdmin: 0,
            assignedAdminId:
              thread.assignedAdminId ?? admin.id,
          })
          .where(eq(supportThreads.id, id));

        await tx.insert(adminAuditLog).values({
          actorUserId: admin.id,
          action: "support_reply",
          targetType: "support_thread",
          targetId: id,
          beforeJson: {},
          afterJson: { len: body.body.length },
        });

        return {
          message: msg,
          userId: thread.userId,
          unreadUser: thread.unreadUser + 1,
        };
      });

      const senderName = await loadAdminDisplayName(app, admin.id);
      const mapped = mapMessage(result.message, senderName ?? "Support");

      const frame: SupportMessageFrame = {
        type: "support_message",
        threadId: id,
        message: mapped,
        unreadUser: result.unreadUser,
      };
      await publishSupportFrame(app.redis, result.userId, frame);

      return { ok: true, message: mapped };
    },
  );

  // ─── Close / Reopen ────────────────────────────────────────────────────
  for (const [path, action] of [
    ["/admin/support/threads/:id/close", "close" as const],
    ["/admin/support/threads/:id/reopen", "reopen" as const],
  ] as const) {
    app.post(path, { config: writeRateLimit }, async (request) => {
      const admin = request.requireRole("support");
      const id = (request.params as { id?: string }).id ?? "";
      if (!UUID_SHAPE.test(id)) {
        throw new NotFoundError("thread_not_found", "thread_not_found");
      }

      const userId = await app.db.transaction(async (tx) => {
        const [thread] = await tx
          .select()
          .from(supportThreads)
          .where(eq(supportThreads.id, id))
          .for("update")
          .limit(1);
        if (!thread) {
          throw new NotFoundError("thread_not_found", "thread_not_found");
        }

        if (action === "close") {
          if (thread.status === "closed") {
            // Idempotent — no-op, no audit row.
            return thread.userId;
          }
          await tx
            .update(supportThreads)
            .set({
              status: "closed",
              closedAt: new Date(),
              closedByUserId: admin.id,
              unreadAdmin: 0,
            })
            .where(eq(supportThreads.id, id));
          await tx.insert(supportMessages).values({
            threadId: id,
            senderKind: "system",
            senderUserId: null,
            body: "Thread closed by support.",
          });
          await tx.insert(adminAuditLog).values({
            actorUserId: admin.id,
            action: "support_thread_close",
            targetType: "support_thread",
            targetId: id,
            beforeJson: {},
            afterJson: {},
          });
        } else {
          if (thread.status === "open") return thread.userId;
          // Reopening requires the partial unique index slot to be
          // free. If the bettor opened a new thread in the meantime
          // (their writer creates a fresh open row when no open thread
          // exists), the index will reject this UPDATE — surface as
          // 409.
          try {
            await tx
              .update(supportThreads)
              .set({
                status: "open",
                closedAt: null,
                closedByUserId: null,
              })
              .where(eq(supportThreads.id, id));
          } catch {
            throw new BadRequestError(
              "another_open_thread_exists",
              "another_open_thread_exists",
            );
          }
          await tx.insert(supportMessages).values({
            threadId: id,
            senderKind: "system",
            senderUserId: null,
            body: "Thread reopened by support.",
          });
          await tx.insert(adminAuditLog).values({
            actorUserId: admin.id,
            action: "support_thread_reopen",
            targetType: "support_thread",
            targetId: id,
            beforeJson: {},
            afterJson: {},
          });
        }

        return thread.userId;
      });

      return { ok: true, userId };
    });
  }

  // ─── Mark read (admin side) ────────────────────────────────────────────
  app.post(
    "/admin/support/threads/:id/mark-read",
    { config: writeRateLimit },
    async (request) => {
      request.requireRole("support");
      const id = (request.params as { id?: string }).id ?? "";
      if (!UUID_SHAPE.test(id)) {
        throw new NotFoundError("thread_not_found", "thread_not_found");
      }
      const updated = await app.db
        .update(supportThreads)
        .set({ unreadAdmin: 0 })
        .where(and(eq(supportThreads.id, id), sql`${supportThreads.unreadAdmin} > 0`))
        .returning({ id: supportThreads.id });
      return { ok: true, marked: updated.length };
    },
  );

  // ─── Sidebar badge ─────────────────────────────────────────────────────
  app.get(
    "/admin/support/unread-count",
    async (request): Promise<AdminSupportUnreadCount> => {
      request.requireRole("support");
      const [row] = await app.db.execute<{ unread: number; threads: number }>(sql`
        SELECT
          COALESCE(SUM(unread_admin), 0)::int AS unread,
          COUNT(*) FILTER (WHERE unread_admin > 0)::int AS threads
          FROM support_threads
         WHERE status = 'open'
      `);
      return { unread: row?.unread ?? 0, threads: row?.threads ?? 0 };
    },
  );

  // Suppress unused warnings for symbols we keep for future expansion.
  void desc;
}
