// Shared support-chat helpers — row-to-API mapping, multipart parsing,
// attachment hydration, and Redis pub/sub fan-out. Kept separate from
// routes.ts so the admin module reuses the same publish + parse paths
// without importing the bettor route file.

import type { Redis } from "ioredis";
import { inArray, sql } from "drizzle-orm";
import type {
  SupportAttachment,
  SupportAttachmentMime,
  SupportMessage,
  SupportMessageFrame,
  SupportThread,
} from "@oddzilla/types";
import {
  SUPPORT_ATTACHMENT_MAX_BYTES,
  SUPPORT_ATTACHMENT_MAX_PER_MESSAGE,
} from "@oddzilla/types";
import {
  supportAttachments,
  type SupportAttachmentRow,
  type SupportMessageRow,
  type SupportThreadRow,
} from "@oddzilla/db";
import type { DbClient } from "@oddzilla/db";
import type { MultipartFile } from "@fastify/multipart";
import { BadRequestError } from "../../lib/errors.js";

/** Reuse the existing ws-gateway `user:{id}` pub/sub channel so the
 * floating support widget shares one WebSocket with live odds + ticket
 * frames. The gateway forwards every frame on this channel verbatim
 * to the matching authenticated sockets (see
 * services/ws-gateway/src/server.ts `dispatchUser`). */
const USER_CHANNEL_PREFIX = "user:";

export const MESSAGE_PAGE_DEFAULT = 100;
export const MESSAGE_PAGE_MAX = 500;

// Re-exported so route modules can import every constant from one
// place rather than juggling two sources of truth.
export const ATTACHMENT_MAX_BYTES = SUPPORT_ATTACHMENT_MAX_BYTES;
export const ATTACHMENT_MAX_PER_MESSAGE = SUPPORT_ATTACHMENT_MAX_PER_MESSAGE;

export function attachmentUrl(id: string | bigint): string {
  return `/support/attachments/${id}`;
}

export function mapThread(row: SupportThreadRow): SupportThread {
  return {
    id: row.id,
    userId: row.userId,
    status: row.status === "closed" ? "closed" : "open",
    subject: row.subject,
    unreadUser: row.unreadUser,
    unreadAdmin: row.unreadAdmin,
    lastMessageAt: row.lastMessageAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
  };
}

export function mapAttachment(row: {
  id: bigint;
  filename: string;
  contentType: string;
  sizeBytes: number;
}): SupportAttachment {
  // Stored MIME passes through verbatim — the byte-serve route is the
  // security boundary (`Content-Disposition: attachment` +
  // `X-Content-Type-Options: nosniff`). The render layer only uses
  // contentType to decide between inline image preview and a
  // download-link chip; both treat unknown values as "download-only".
  return {
    id: String(row.id),
    filename: row.filename,
    contentType: row.contentType || "application/octet-stream",
    sizeBytes: row.sizeBytes,
    url: attachmentUrl(row.id),
  };
}

export function mapMessage(
  // Structural subset so callers can pass either a full SupportMessageRow
  // (which carries via_ai) or a hand-built literal (admin/bettor detail
  // selects). viaAi is optional and defaults false.
  row: Pick<
    SupportMessageRow,
    "id" | "threadId" | "senderKind" | "senderUserId" | "body" | "createdAt"
  > & { viaAi?: boolean },
  attachments: SupportAttachment[] = [],
  senderName?: string | null,
): SupportMessage {
  return {
    id: String(row.id),
    threadId: row.threadId,
    senderKind: row.senderKind,
    senderUserId: row.senderUserId,
    senderName: senderName ?? null,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    attachments,
    viaAi: Boolean(row.viaAi),
  };
}

/** Load attachments for a set of messages in one query and return a
 * Map keyed by string-of-message-id. Empty input short-circuits to an
 * empty map without round-tripping. */
export async function loadAttachmentsFor(
  db: DbClient,
  messageIds: bigint[],
): Promise<Map<string, SupportAttachment[]>> {
  const map = new Map<string, SupportAttachment[]>();
  if (messageIds.length === 0) return map;
  const rows = await db
    .select({
      id: supportAttachments.id,
      messageId: supportAttachments.messageId,
      filename: supportAttachments.filename,
      contentType: supportAttachments.contentType,
      sizeBytes: supportAttachments.sizeBytes,
    })
    .from(supportAttachments)
    .where(inArray(supportAttachments.messageId, messageIds))
    .orderBy(supportAttachments.id);
  for (const r of rows) {
    const key = String(r.messageId);
    const list = map.get(key) ?? [];
    list.push(
      mapAttachment({
        id: r.id,
        filename: r.filename,
        contentType: r.contentType,
        sizeBytes: r.sizeBytes,
      }),
    );
    map.set(key, list);
  }
  return map;
}

/** Strip path separators + trim to 255 chars so a misbehaving client
 * can't sneak a relative-path filename into the row. We never use the
 * value as a file system path (storage is BYTEA in the DB), but it's
 * shown to humans on download so a sanitised display name is the
 * right hygiene. */
export function sanitiseFilename(raw: string | null | undefined): string {
  const fallback = "attachment";
  if (!raw) return fallback;
  const noPaths = raw.replace(/[\\/]+/g, "_");
  const trimmed = noPaths.trim();
  if (trimmed.length === 0) return fallback;
  // Keep the extension but cap total length.
  return trimmed.slice(0, 255);
}

export interface ParsedAttachment {
  filename: string;
  contentType: SupportAttachmentMime;
  data: Buffer;
}

export interface ParsedSupportPayload {
  body: string;
  subject?: string;
  attachments: ParsedAttachment[];
}

/** Convert a single multipart file part to a validated ParsedAttachment
 * or throw a typed error the caller can pass straight to Fastify. The
 * multipart plugin's `truncated` flag fires when the stream was
 * truncated at the per-file byte limit; we surface that explicitly so
 * the caller doesn't think a partial buffer is a complete file. */
export async function parseAttachmentPart(
  part: MultipartFile,
): Promise<ParsedAttachment> {
  const buffer = await part.toBuffer();
  if (part.file.truncated) {
    throw new BadRequestError(
      "attachment_too_large",
      "attachment_too_large",
    );
  }
  if (buffer.length === 0) {
    throw new BadRequestError("attachment_empty", "attachment_empty");
  }
  if (buffer.length > ATTACHMENT_MAX_BYTES) {
    // Should be unreachable — fileSize stream limit catches first —
    // but guard at the route layer too.
    throw new BadRequestError(
      "attachment_too_large",
      "attachment_too_large",
    );
  }
  // Any client-supplied MIME is accepted. Browsers sometimes omit the
  // header entirely (e.g. for unrecognised extensions); fall back to
  // the generic binary type so the row stays well-formed.
  const mime = part.mimetype && part.mimetype.length > 0
    ? part.mimetype
    : "application/octet-stream";
  return {
    filename: sanitiseFilename(part.filename),
    contentType: mime,
    data: buffer,
  };
}

export async function publishSupportFrame(
  redis: Redis,
  userId: string,
  frame: SupportMessageFrame,
): Promise<void> {
  try {
    await redis.publish(USER_CHANNEL_PREFIX + userId, JSON.stringify(frame));
  } catch {
    // Best-effort — DB is the source of truth. Widget refetches on
    // next mount / interval if a frame drops.
  }
}

// Helper kept for symmetry with `inArray` typing — silences unused
// import when the build isolates dead exports.
void sql;
