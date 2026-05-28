// /support/me/* — bettor-facing live chat with the backoffice. Plus
// the shared byte-serve route for attachment downloads.
//
//   GET   /support/me/thread        Open thread (creates lazily on
//                                   first message) + recent messages
//                                   + unread counter + attachments.
//   POST  /support/me/messages      multipart/form-data — `body` text
//                                   field plus up to 5 `files[]` parts
//                                   (10 MiB each). Re-opens any closed
//                                   thread by spawning a fresh one
//                                   (the partial unique index gates
//                                   one open row per user).
//   POST  /support/me/mark-read     Clears unread_user on the bettor's
//                                   open thread. Idempotent.
//   GET   /support/attachments/:id  Byte-serve. Permission gate: the
//                                   thread's bettor OR any admin /
//                                   support operator. Streams the
//                                   stored MIME with
//                                   `Content-Disposition: attachment`
//                                   so browsers never auto-render
//                                   untrusted PDFs / SVGs as the
//                                   active page context.
//
// Real-time fan-out rides the same `user:{userId}` Redis channel used
// for ticket frames — the floating widget consumes it via the shared
// WebSocket (see apps/web/src/lib/use-support-stream.ts).

import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import multipart from "@fastify/multipart";
import {
  supportAttachments,
  supportMessages,
  supportThreads,
} from "@oddzilla/db";
import type { SupportMessageFrame } from "@oddzilla/types";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "../../lib/errors.js";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  loadAttachmentsFor,
  mapMessage,
  mapThread,
  parseAttachmentPart,
  publishSupportFrame,
  type ParsedAttachment,
  MESSAGE_PAGE_DEFAULT,
} from "./shared.js";

const writeRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute" },
};

const BODY_MAX_LEN = 2000;
const SUBJECT_MAX_LEN = 200;

function trimToLength(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

export default async function supportUserRoutes(app: FastifyInstance) {
  // Multipart is encapsulated in this plugin scope so the other
  // JSON-body support endpoints (mark-read) keep their default
  // parsing. Limits are belt + braces: the stream rejects oversize
  // uploads before they hit handler memory, and the per-part counter
  // mirrors the API-layer cap.
  await app.register(multipart, {
    limits: {
      fileSize: ATTACHMENT_MAX_BYTES,
      files: ATTACHMENT_MAX_PER_MESSAGE,
      // Two text fields: body + subject. fieldSize is per-field;
      // 4 KiB easily covers our 2000-char body + 200-char subject.
      fields: 4,
      fieldSize: 4096,
    },
  });

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

    const ascending = rows.slice().reverse();
    const attachmentsByMessage = await loadAttachmentsFor(
      app.db,
      ascending.map((r) => r.id),
    );
    const messages = ascending.map((r) =>
      mapMessage(r, attachmentsByMessage.get(String(r.id)) ?? []),
    );
    return { thread: mapThread(thread), messages };
  });

  // ─── Post a bettor message (multipart) ────────────────────────────────
  app.post(
    "/support/me/messages",
    { config: writeRateLimit },
    async (request) => {
      const u = request.requireAuth();

      if (!request.isMultipart()) {
        // The widget always sends FormData, so a non-multipart POST
        // is either an outdated client or a direct curl probe. Reject
        // with a clear code rather than letting zod see undefined
        // and surface a less-actionable validation_error.
        throw new BadRequestError(
          "multipart_required",
          "multipart_required",
        );
      }

      let bodyText = "";
      let subject: string | undefined;
      const attachments: ParsedAttachment[] = [];

      for await (const part of request.parts()) {
        if (part.type === "field") {
          if (part.fieldname === "body") {
            const raw = typeof part.value === "string" ? part.value : "";
            bodyText = trimToLength(raw, BODY_MAX_LEN);
          } else if (part.fieldname === "subject") {
            const raw = typeof part.value === "string" ? part.value : "";
            const trimmed = trimToLength(raw, SUBJECT_MAX_LEN);
            if (trimmed.length > 0) subject = trimmed;
          }
          // Unknown fields are silently ignored.
          continue;
        }
        // File part. Reject early if the cap would be exceeded so we
        // don't read the rest of the stream just to throw.
        if (attachments.length >= ATTACHMENT_MAX_PER_MESSAGE) {
          throw new BadRequestError(
            "too_many_attachments",
            "too_many_attachments",
          );
        }
        attachments.push(await parseAttachmentPart(part));
      }

      const hasBody = bodyText.length > 0;
      const hasAttachments = attachments.length > 0;
      if (!hasBody && !hasAttachments) {
        throw new BadRequestError(
          "body_or_attachment_required",
          "body_or_attachment_required",
        );
      }

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
          // to the trimmed body when not provided, falling back to the
          // first attachment's filename when the message is media-only.
          let initialSubject = subject ?? "";
          if (initialSubject.length === 0) {
            initialSubject =
              hasBody
                ? bodyText.slice(0, 80)
                : (attachments[0]?.filename.slice(0, 80) ?? "Attachment");
          }
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
            body: bodyText,
          })
          .returning();
        if (!msg) throw new Error("support message insert empty");

        const insertedAttachments =
          hasAttachments
            ? await tx
                .insert(supportAttachments)
                .values(
                  attachments.map((a) => ({
                    messageId: msg.id,
                    filename: a.filename,
                    contentType: a.contentType,
                    sizeBytes: a.data.length,
                    data: a.data,
                  })),
                )
                .returning({
                  id: supportAttachments.id,
                  filename: supportAttachments.filename,
                  contentType: supportAttachments.contentType,
                  sizeBytes: supportAttachments.sizeBytes,
                })
            : [];

        return {
          threadId,
          message: msg,
          attachments: insertedAttachments,
          unreadUser,
          unreadAdmin,
        };
      });

      const attachmentDtos = result.attachments.map((row) => ({
        id: String(row.id),
        filename: row.filename,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        url: `/support/attachments/${row.id}`,
      })) as ReturnType<typeof mapMessage>["attachments"];

      const mapped = mapMessage(result.message, attachmentDtos);

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

  // ─── Attachment byte-serve ────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/support/attachments/:id",
    async (request, reply) => {
      const u = request.requireAuth();
      const idRaw = request.params.id ?? "";
      // BIGINT id — accept digits only. Anything else is a typo or
      // probe; surface as 404 (don't leak whether the id exists).
      if (!/^\d{1,19}$/.test(idRaw)) {
        throw new NotFoundError("attachment_not_found", "attachment_not_found");
      }

      const [row] = await app.db
        .select({
          filename: supportAttachments.filename,
          contentType: supportAttachments.contentType,
          sizeBytes: supportAttachments.sizeBytes,
          data: supportAttachments.data,
          threadUserId: supportThreads.userId,
        })
        .from(supportAttachments)
        .innerJoin(
          supportMessages,
          eq(supportMessages.id, supportAttachments.messageId),
        )
        .innerJoin(
          supportThreads,
          eq(supportThreads.id, supportMessages.threadId),
        )
        .where(eq(supportAttachments.id, BigInt(idRaw)))
        .limit(1);

      if (!row) {
        throw new NotFoundError("attachment_not_found", "attachment_not_found");
      }

      const isOwner = row.threadUserId === u.id;
      const isOperator = u.role === "admin" || u.role === "support";
      if (!isOwner && !isOperator) {
        throw new ForbiddenError();
      }

      // Force `attachment` disposition so a browser can't auto-render
      // PDF/text/etc. as the active page — defence against shell
      // gadgets in user-supplied content. We rely on the MIME
      // allowlist for additional safety.
      const safeFilename = row.filename.replace(/["\\\r\n]/g, "_");
      reply
        .header("content-type", row.contentType)
        .header("content-length", row.sizeBytes.toString())
        .header(
          "content-disposition",
          `attachment; filename="${safeFilename}"`,
        )
        // Short-lived private cache — same response shouldn't be served
        // to a different user from a shared proxy.
        .header("cache-control", "private, max-age=300")
        .send(row.data);
    },
  );

  // Suppress unused import warnings on symbols kept for future
  // endpoint expansion.
  void asc;
}
