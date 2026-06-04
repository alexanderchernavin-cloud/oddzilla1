// /webhooks/support-ai/:secret/* — server-to-server endpoints for the
// autonomous Gemma support assistant. The worker (services/support-ai-bot)
// runs on an operator PC, polls these over outbound HTTPS, runs the local
// model via LM Studio, and posts replies back.
//
// Auth: the :secret path component is constant-time compared against
// SUPPORT_AI_BOT_TOKEN. Mounted under /webhooks/ so the CSRF plugin skips it
// (server-to-server, no Origin header) and Caddy's /api/* proxy exposes it
// publicly at https://<host>/api/webhooks/support-ai/<secret>/...
//
// When SUPPORT_AI_BOT_TOKEN is unset every route 503s bot_disabled — the same
// graceful-idle shape Disir / OBB / email use.
//
// Replies are attributed to the seeded AI support user (AI_SUPPORT_USER_ID),
// stored as sender_kind='admin' + via_ai=true, and fan out on the bettor's
// user:{id} Redis channel exactly like a human reply. Every mutation writes
// an admin_audit_log row (actor = the AI user).

import type { FastifyInstance, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { asc, desc, eq, sql } from "drizzle-orm";
import { loadEnv } from "@oddzilla/config";
import { adminAuditLog, supportMessages, supportThreads } from "@oddzilla/db";
import type { SupportMessageRow } from "@oddzilla/db";
import {
  AI_SUPPORT_USER_ID,
  type SupportBotPendingResponse,
  type SupportMessageFrame,
} from "@oddzilla/types";
import {
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../../lib/errors.js";
import { mapMessage, publishSupportFrame } from "../shared.js";
import { buildAccountFacts } from "./account-facts.js";

const UUID_SHAPE = /^[0-9a-f-]{36}$/i;
const REPLY_BODY_MAX = 4000;
const RECENT_MESSAGE_LIMIT = 20;
const AI_ONLINE_KEY = "support:ai:online";
const AI_ONLINE_TTL_SECONDS = 45;
const ASSISTANT_DISPLAY_NAME = "Oddzilla Assistant";

const replySchema = z.object({
  text: z.string().trim().min(1).max(REPLY_BODY_MAX),
});
const escalateSchema = z.object({
  reason: z.string().trim().max(500).optional(),
  holdingMessage: z.string().trim().max(REPLY_BODY_MAX).optional(),
});
const pendingQuery = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export default async function supportBotRoutes(app: FastifyInstance) {
  const token = loadEnv().SUPPORT_AI_BOT_TOKEN;

  function assertBotAuth(request: FastifyRequest): void {
    if (!token) {
      throw new ServiceUnavailableError("bot_disabled", "bot_disabled");
    }
    const provided = (request.params as { secret?: string }).secret ?? "";
    if (!constantTimeEquals(provided, token)) {
      // 404 rather than 401 so the route's existence isn't confirmable to
      // a scanner that doesn't already hold the secret.
      throw new NotFoundError("not_found", "not_found");
    }
  }

  function parseThreadId(request: FastifyRequest): string {
    const id = (request.params as { id?: string }).id ?? "";
    if (!UUID_SHAPE.test(id)) {
      throw new NotFoundError("thread_not_found", "thread_not_found");
    }
    return id;
  }

  // ─── Work queue: open, AI-handled threads with an unanswered bettor msg ──
  app.get(
    "/webhooks/support-ai/:secret/pending",
    async (request): Promise<SupportBotPendingResponse> => {
      assertBotAuth(request);
      const { limit } = pendingQuery.parse(request.query);

      const threadRows = await app.db
        .select({
          id: supportThreads.id,
          userId: supportThreads.userId,
          subject: supportThreads.subject,
        })
        .from(supportThreads)
        .where(
          sql`${supportThreads.status} = 'open' AND ${supportThreads.aiHandling} = true AND ${supportThreads.unreadAdmin} > 0`,
        )
        .orderBy(asc(supportThreads.lastMessageAt))
        .limit(limit);

      const threads = await Promise.all(
        threadRows.map(async (t) => {
          const recent = await app.db
            .select({
              senderKind: supportMessages.senderKind,
              viaAi: supportMessages.viaAi,
              body: supportMessages.body,
              createdAt: supportMessages.createdAt,
            })
            .from(supportMessages)
            .where(eq(supportMessages.threadId, t.id))
            .orderBy(desc(supportMessages.id))
            .limit(RECENT_MESSAGE_LIMIT);
          recent.reverse(); // chronological ascending for the prompt
          const accountFacts = await buildAccountFacts(app, t.userId);
          return {
            threadId: t.id,
            userId: t.userId,
            subject: t.subject,
            messages: recent.map((m) => ({
              sender: m.senderKind,
              viaAi: m.viaAi,
              body: m.body,
              createdAt: m.createdAt.toISOString(),
            })),
            accountFacts,
          };
        }),
      );

      return { threads };
    },
  );

  // ─── Post a reply (text only) ────────────────────────────────────────────
  app.post("/webhooks/support-ai/:secret/threads/:id/reply", async (request) => {
    assertBotAuth(request);
    const id = parseThreadId(request);
    const { text } = replySchema.parse(request.body ?? {});

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
      if (!thread.aiHandling) {
        // A human took over (or the bot escalated). The assistant must not
        // re-enter the conversation until an operator clicks "Resume AI".
        throw new BadRequestError("ai_paused", "ai_paused");
      }

      const [msg] = await tx
        .insert(supportMessages)
        .values({
          threadId: id,
          senderKind: "admin",
          senderUserId: AI_SUPPORT_USER_ID,
          viaAi: true,
          body: text,
        })
        .returning();
      if (!msg) throw new Error("support ai message insert empty");

      await tx
        .update(supportThreads)
        .set({
          lastMessageAt: new Date(),
          unreadUser: sql`${supportThreads.unreadUser} + 1`,
          unreadAdmin: 0,
          assignedAdminId: thread.assignedAdminId ?? AI_SUPPORT_USER_ID,
        })
        .where(eq(supportThreads.id, id));

      await tx.insert(adminAuditLog).values({
        actorUserId: AI_SUPPORT_USER_ID,
        action: "support_ai_reply",
        targetType: "support_thread",
        targetId: id,
        beforeJson: {},
        afterJson: { len: text.length },
      });

      return {
        message: msg,
        userId: thread.userId,
        unreadUser: thread.unreadUser + 1,
      };
    });

    const mapped = mapMessage(result.message, [], ASSISTANT_DISPLAY_NAME);
    const frame: SupportMessageFrame = {
      type: "support_message",
      threadId: id,
      message: mapped,
      unreadUser: result.unreadUser,
    };
    await publishSupportFrame(app.redis, result.userId, frame);

    return { ok: true, message: mapped };
  });

  // ─── Escalate to a human ─────────────────────────────────────────────────
  app.post("/webhooks/support-ai/:secret/threads/:id/escalate", async (request) => {
    assertBotAuth(request);
    const id = parseThreadId(request);
    const body = escalateSchema.parse(request.body ?? {});
    const holding =
      body.holdingMessage && body.holdingMessage.length > 0
        ? body.holdingMessage.slice(0, REPLY_BODY_MAX)
        : null;

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

      let message: SupportMessageRow | null = null;
      let unreadUser = thread.unreadUser;
      if (holding) {
        const [msg] = await tx
          .insert(supportMessages)
          .values({
            threadId: id,
            senderKind: "admin",
            senderUserId: AI_SUPPORT_USER_ID,
            viaAi: true,
            body: holding,
          })
          .returning();
        if (!msg) throw new Error("support ai holding insert empty");
        message = msg;
        unreadUser = thread.unreadUser + 1;
        // Bump bettor-side unread + pause AI. Deliberately DO NOT touch
        // unread_admin: leaving it > 0 keeps the thread in the operator
        // "unread" queue so a human picks it up.
        await tx
          .update(supportThreads)
          .set({
            lastMessageAt: new Date(),
            unreadUser: sql`${supportThreads.unreadUser} + 1`,
            aiHandling: false,
            aiPausedAt: new Date(),
          })
          .where(eq(supportThreads.id, id));
      } else {
        await tx
          .update(supportThreads)
          .set({ aiHandling: false, aiPausedAt: new Date() })
          .where(eq(supportThreads.id, id));
      }

      await tx.insert(adminAuditLog).values({
        actorUserId: AI_SUPPORT_USER_ID,
        action: "support_ai_escalate",
        targetType: "support_thread",
        targetId: id,
        beforeJson: {},
        afterJson: { reason: body.reason ?? null, holding: Boolean(holding) },
      });

      return { message, userId: thread.userId, unreadUser };
    });

    if (result.message) {
      const mapped = mapMessage(result.message, [], ASSISTANT_DISPLAY_NAME);
      const frame: SupportMessageFrame = {
        type: "support_message",
        threadId: id,
        message: mapped,
        unreadUser: result.unreadUser,
      };
      await publishSupportFrame(app.redis, result.userId, frame);
    }

    return { ok: true };
  });

  // ─── Heartbeat — drives the admin "assistant online" indicator ───────────
  app.post("/webhooks/support-ai/:secret/heartbeat", async (request) => {
    assertBotAuth(request);
    const now = new Date().toISOString();
    try {
      await app.redis.set(AI_ONLINE_KEY, now, "EX", AI_ONLINE_TTL_SECONDS);
    } catch {
      // Best-effort — the indicator just shows offline if Redis blips.
    }
    return { ok: true, lastSeen: now };
  });
}
