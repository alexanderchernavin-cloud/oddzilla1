// Threading helpers for inbound mail.
//
// We follow RFC 5322 conventions: a reply carries In-Reply-To (the
// Message-ID of the parent) and References (the full chain). New
// conversations have neither. If a user uses a client that strips
// those headers (rare but happens), we fall back to a normalised
// subject match against active threads.
//
// IDs are stored WITHOUT angle brackets in the DB. The `<>` wrapping
// is a header-format artefact, not part of the canonical value;
// normalising at read time makes equality checks straightforward.

import { eq, sql } from "drizzle-orm";
import type { DbClient } from "@oddzilla/db";
import { emailInbound, emailOutbox, emailThreads } from "@oddzilla/db";

type TxHandle = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
export type DbOrTx = DbClient | TxHandle;

/** Strip a Message-ID-style header value down to the bare id@domain
 * portion. Handles `<id@domain>`, `id@domain`, and surrounding
 * whitespace. Returns null when the value is empty/invalid. */
export function normaliseMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/<([^>]+)>/);
  const inner = match ? match[1]! : trimmed;
  const value = inner.trim();
  return value.length > 0 ? value : null;
}

/** Extract every angle-bracketed id from a References header value.
 * Order is preserved — the spec says References is oldest-to-newest
 * so the LAST id is the most recent ancestor. */
export function parseReferencesChain(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const ids: string[] = [];
  for (const match of raw.matchAll(/<([^>]+)>/g)) {
    const id = match[1]?.trim();
    if (id && id.length > 0) ids.push(id);
  }
  return ids;
}

/** Normalise a subject for fallback matching. Strips repeated reply /
 * forward prefixes across English / Russian / Czech / Spanish /
 * Portuguese conventions, collapses whitespace, lowercases. */
export function normaliseSubject(subject: string): string {
  return subject
    .replace(/^\s*((re|fwd?|aw|sv|tr|fw|odp|odpoveď|res|enc):\s*)+/iu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Look up an existing thread by a referenced Message-ID. Checks both
 * our outbox (we may have sent the original) and prior inbound rows
 * (the user is replying to another user's message that we already
 * received — same-thread continuation). */
export async function findThreadByReferencedMessageId(
  tx: DbOrTx,
  messageId: string,
): Promise<string | null> {
  const [outboxHit] = await tx
    .select({ tid: emailOutbox.threadId })
    .from(emailOutbox)
    .where(eq(emailOutbox.providerMessageId, messageId))
    .limit(1);
  if (outboxHit?.tid) return outboxHit.tid;

  const [inboundHit] = await tx
    .select({ tid: emailInbound.threadId })
    .from(emailInbound)
    .where(eq(emailInbound.messageId, messageId))
    .limit(1);
  return inboundHit?.tid ?? null;
}

/** Subject-based thread match against the most-recent active thread
 * sharing the normalised subject. Limited to last 30 days so a "Hello"
 * reply doesn't collide with an unrelated thread from 6 months ago. */
export async function findThreadByNormalisedSubject(
  tx: DbOrTx,
  normalised: string,
): Promise<string | null> {
  if (!normalised) return null;
  const [hit] = await tx
    .select({ id: emailThreads.id })
    .from(emailThreads)
    .where(
      sql`${emailThreads.normalisedSubject} = ${normalised}
          AND ${emailThreads.archivedAt} IS NULL
          AND GREATEST(COALESCE(${emailThreads.lastInboundAt}, ${emailThreads.createdAt}),
                       COALESCE(${emailThreads.lastOutboundAt}, ${emailThreads.createdAt})) > NOW() - INTERVAL '30 days'`,
    )
    .orderBy(
      sql`GREATEST(COALESCE(${emailThreads.lastInboundAt}, ${emailThreads.createdAt}),
                   COALESCE(${emailThreads.lastOutboundAt}, ${emailThreads.createdAt})) DESC`,
    )
    .limit(1);
  return hit?.id ?? null;
}

export interface ThreadResolutionInput {
  inReplyTo: string | null;
  referencesChain: string[];
  subject: string;
  fromAddress: string;
  toAddress: string;
}

/** Resolve the thread an inbound message belongs to. Walk three
 * strategies in order: explicit In-Reply-To, References chain
 * (newest first), normalised subject. Creates a new thread when
 * nothing matches. */
export async function resolveOrCreateThread(
  tx: DbOrTx,
  input: ThreadResolutionInput,
): Promise<string> {
  // 1. In-Reply-To: the canonical "this is a reply to X" hint.
  if (input.inReplyTo) {
    const hit = await findThreadByReferencedMessageId(tx, input.inReplyTo);
    if (hit) return hit;
  }

  // 2. References chain: walk from newest to oldest. The last entry
  // is the most recent ancestor; if any of them matches, use that
  // thread.
  for (let i = input.referencesChain.length - 1; i >= 0; i--) {
    const hit = await findThreadByReferencedMessageId(tx, input.referencesChain[i]!);
    if (hit) return hit;
  }

  // 3. Subject fallback (best-effort, only for active recent threads).
  const normalised = normaliseSubject(input.subject);
  if (normalised) {
    const hit = await findThreadByNormalisedSubject(tx, normalised);
    if (hit) return hit;
  }

  // 4. New thread.
  const [row] = await tx
    .insert(emailThreads)
    .values({
      subject: input.subject,
      normalisedSubject: normalised || input.subject.toLowerCase(),
      firstFrom: input.fromAddress,
      firstTo: input.toAddress,
    })
    .returning({ id: emailThreads.id });
  if (!row) throw new Error("email_threads insert returned no row");
  return row.id;
}
