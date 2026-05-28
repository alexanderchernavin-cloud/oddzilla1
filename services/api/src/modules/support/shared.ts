// Shared support-chat helpers — row-to-API mapping + Redis pub/sub
// fan-out. Kept separate from routes.ts so the admin module can reuse
// the same publish path without importing the bettor route file.

import type { Redis } from "ioredis";
import type {
  SupportMessage,
  SupportMessageFrame,
  SupportThread,
} from "@oddzilla/types";
import type {
  SupportMessageRow,
  SupportThreadRow,
} from "@oddzilla/db";

/** Reuse the existing ws-gateway `user:{id}` pub/sub channel so the
 * floating support widget shares one WebSocket with live odds + ticket
 * frames. The gateway forwards every frame on this channel verbatim
 * to the matching authenticated sockets (see
 * services/ws-gateway/src/server.ts `dispatchUser`). */
const USER_CHANNEL_PREFIX = "user:";

export const MESSAGE_PAGE_DEFAULT = 100;
export const MESSAGE_PAGE_MAX = 500;

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

export function mapMessage(
  row: SupportMessageRow,
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
