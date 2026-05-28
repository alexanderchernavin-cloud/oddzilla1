// /support/me/* — bettor-facing live chat with the backoffice.
//
//   GET   /support/me/thread       Open thread (creates lazily on first message)
//                                  + recent messages + unread counter.
//   POST  /support/me/messages     Post a new bettor message. Re-opens any
//                                  closed thread by spawning a fresh one
//                                  (the partial unique index gates one
//                                  open row per user).
//   POST  /support/me/mark-read    Clears unread_user on the bettor's open
//                                  thread. Idempotent.
//
// Real-time fan-out rides the same `user:{userId}` Redis channel used
// for ticket frames — the floating widget consumes it via the shared
// WebSocket (see apps/web/src/lib/use-support-stream.ts).

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { supportMessages, supportThreads } from "@oddzilla/db";
import type { SupportMessageFrame } from "@oddzilla/types";
import {
  BadRequestError,
  NotFoundError,
} from "../../lib/errors.js";
import {
  mapMessage,
  mapThread,
  publishSupportFrame,
  MESSAGE_PAGE_DEFAULT,
} from "./shared.js";

const postMessageBody = z.object({
  body: z.string().trim().min(1).max(2000),
  /** Optional subject — only used when this is the very first message
   * on a brand-new thread. Ignored when the user already has an open
   * thread (the original subject sticks). */
  subject: z.string().trim().min(1).max(200).optional(),
});

const writeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

export default async function supportUserRoutes(app: FastifyInstance) {
  // ─── My thread + recent messages ───────────────────────────────────────
  app.get("/support/me/thread", async (request) => {
    const u = request.requireAuth();

    const [thread] = await app.db
      .select()
      .from(supportThreads)
      .where(
        and(eq(supportThreads.userId, u.id), eq(supportThreads.status, "open")),
      )
      .limit(1);

    if (!thread) {
      return { thread: null, messages: [] };
    }

    const rows = await app.db
      .select()
      .from(supportMessages)
      .where(eq(supportMessages.threadId, thread.id))
      .orderBy(desc(supportMessages.id))
      .limit(MESSAGE_PAGE_DEFAULT);

    // Return ascending chronological so the widget renders top-to-bottom
    // without an extra client-side reverse. Wrap mapMessage in an arrow
    // so the index passed by Array#map doesn't bind to its optional
    // senderName parameter.
    const messages = rows.slice().reverse().map((r) => mapMessage(r));
    return { thread: mapThread(thread), messages };
  });

  // ─── Post a bettor message ────────────────────────────────────────────
  app.post(
    "/support/me/messages",
    { config: writeRateLimit },
    async (request) => {
      const u = request.requireAuth();
      const body = postMessageBody.parse(request.body);

      const result = await app.db.transaction(async (tx) => {
        // Lock the bettor's open thread if it exists. SELECT FOR UPDATE
        // is essential — two concurrent POSTs from the same bettor
        // would otherwise race the partial-unique-index INSERT below
        // and one would be rejected, even though the second placement
        // should just append to the first's thread.
        const [existing] = await tx
          .select()
          .from(supportThreads)
          .where(
            and(
              eq(supportThreads.userId, u.id),
              eq(supportThreads.status, "open"),
            ),
          )
          .for("update")
          .limit(1);

        let threadId: string;
        let unreadAdmin: number;
        let unreadUser: number;

        if (existing) {
          threadId = existing.id;
          unreadAdmin = existing.unreadAdmin + 1;
          unreadUser = existing.unreadUser;
          await tx
            .update(supportThreads)
            .set({
              lastMessageAt: new Date(),
              unreadAdmin: sql`${supportThreads.unreadAdmin} + 1`,
            })
            .where(eq(supportThreads.id, threadId));
        } else {
          // First-ever or closed-and-restarted thread. Subject defaults
          // to the trimmed body when not provided so the inbox row
          // shows something more informative than NULL.
          const initialSubject =
            body.subject ?? body.body.slice(0, 80);
          const [inserted] = await tx
            .insert(supportThreads)
            .values({
              userId: u.id,
              status: "open",
              subject: initialSubject,
              unreadAdmin: 1,
              unreadUser: 0,
            })
            .returning({ id: supportThreads.id });
          if (!inserted) throw new Error("support thread insert empty");
          threadId = inserted.id;
          unreadAdmin = 1;
          unreadUser = 0;
        }

        const [msg] = await tx
          .insert(supportMessages)
          .values({
            threadId,
            senderKind: "user",
            senderUserId: u.id,
            body: body.body,
          })
          .returning();
        if (!msg) throw new Error("support message insert empty");

        return { threadId, message: msg, unreadUser, unreadAdmin };
      });

      const mapped = mapMessage(result.message);

      // Fan-out: publish to the bettor's own user channel so any other
      // tabs they have open update without re-fetching. (Admin-side
      // updates ride the admin sidebar's 60 s poll — there's no
      // global admin pub/sub channel.)
      const frame: SupportMessageFrame = {
        type: "support_message",
        threadId: result.threadId,
        message: mapped,
        unreadUser: result.unreadUser,
      };
      await publishSupportFrame(app.redis, u.id, frame);

      return { threadId: result.threadId, message: mapped };
    },
  );

  // ─── Mark read ─────────────────────────────────────────────────────────
  app.post(
    "/support/me/mark-read",
    { config: writeRateLimit },
    async (request) => {
      const u = request.requireAuth();
      const updated = await app.db
        .update(supportThreads)
        .set({ unreadUser: 0 })
        .where(
          and(
            eq(supportThreads.userId, u.id),
            eq(supportThreads.status, "open"),
          ),
        )
        .returning({ id: supportThreads.id });
      return { ok: true, marked: updated.length };
    },
  );

  // Suppress unused imports — kept for future endpoint expansion.
  void BadRequestError;
  void NotFoundError;
}
