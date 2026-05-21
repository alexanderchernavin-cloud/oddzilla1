// SendGrid Inbound Parse webhook.
//
// Mounted at /webhooks/sendgrid-inbound/:secret. The secret in the
// path is the auth gate — SendGrid doesn't sign webhooks, so URL
// possession is the credential. The path component is constant-time
// compared against SENDGRID_INBOUND_SECRET; mismatches return 404 so
// scanners can't tell whether the route exists.
//
// SendGrid posts multipart/form-data with these fields:
//   to            — header To
//   from          — header From
//   subject       — header Subject
//   text          — text/plain body (if available)
//   html          — text/html body  (if available)
//   headers       — full raw header block as a string
//   envelope      — JSON: {to: [...], from: "..."} (SMTP envelope)
//   spam_score    — numeric, when spam check is enabled
//   attachments   — count
//   attachment-info — JSON: {attachment1: {filename, type, ...}, ...}
//   attachment1, attachment2, ... — file uploads
//
// First slice ignores attachments (records metadata only). Future work
// can wire blob storage.

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { loadEnv } from "@oddzilla/config";
import { emailInbound, emailThreads } from "@oddzilla/db";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { NotFoundError, ServiceUnavailableError } from "../../../lib/errors.js";
import { parseAddress, parseHeaders } from "./headers.js";
import {
  normaliseMessageId,
  parseReferencesChain,
  resolveOrCreateThread,
} from "./threading.js";

interface AttachmentMeta {
  filename: string;
  contentType: string | null;
  sizeBytes: number;
}

interface SendGridFields {
  to: string | null;
  from: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  headersRaw: string | null;
  envelope: string | null;
  spamScore: string | null;
  attachmentInfo: string | null;
  attachments: AttachmentMeta[];
}

// SendGrid's payloads can be a few hundred KB with HTML + headers,
// rarely more without attachments. 5 MiB is a comfortable upper bound
// that still bounds memory if a malicious caller tries to stuff us.
const PARSE_LIMITS = {
  fieldSize: 1024 * 1024,        // 1 MiB per field (HTML can grow)
  fileSize: 5 * 1024 * 1024,     // 5 MiB per attachment (we discard)
  files: 50,
  fields: 50,
};

const BODY_LIMIT_BYTES = 8 * 1024 * 1024; // route-level body cap

export default async function inboundEmailRoutes(app: FastifyInstance) {
  // @fastify/multipart is encapsulated — register inside this plugin
  // scope so it only applies to the webhook route. Avoids interfering
  // with the JSON body parsing every other route uses.
  await app.register(multipart, {
    limits: PARSE_LIMITS,
    attachFieldsToBody: false, // we iterate parts ourselves
  });

  app.post(
    "/webhooks/sendgrid-inbound/:secret",
    {
      bodyLimit: BODY_LIMIT_BYTES,
      // No rate limit — SendGrid is the only legitimate caller and
      // they throttle their own redelivery cadence.
    },
    async (request, reply) => {
      const env = loadEnv();
      if (!env.SENDGRID_INBOUND_SECRET) {
        throw new ServiceUnavailableError(
          "inbound_disabled",
          "inbound_disabled",
        );
      }
      const provided = (request.params as { secret?: string }).secret ?? "";
      if (!constantTimeEquals(provided, env.SENDGRID_INBOUND_SECRET)) {
        // 404, not 401 — don't tell scanners the route exists.
        throw new NotFoundError("not_found", "not_found");
      }

      const fields = await collectFields(request);
      const headers = parseHeaders(fields.headersRaw ?? "");

      const messageId = normaliseMessageId(headers.get("message-id"));
      const inReplyTo = normaliseMessageId(headers.get("in-reply-to"));
      const referencesChain = parseReferencesChain(headers.get("references"));

      const from = parseAddress(fields.from);
      const to = parseAddress(fields.to);
      if (!from || !to) {
        request.log.warn(
          { from: fields.from, to: fields.to },
          "inbound: missing from/to, dropping",
        );
        return reply.code(202).send({ accepted: false, reason: "missing_addresses" });
      }

      const subject = (fields.subject ?? "").trim() || "(no subject)";
      const spamScore =
        fields.spamScore && !Number.isNaN(Number(fields.spamScore))
          ? fields.spamScore
          : null;
      const envelopeFrom = extractEnvelopeFrom(fields.envelope);

      // Idempotency: if SendGrid retries and we already have this
      // message_id, return 200 fast without re-inserting.
      if (messageId) {
        const existing = await app.db
          .select({ id: emailInbound.id })
          .from(emailInbound)
          .where(eq(emailInbound.messageId, messageId))
          .limit(1);
        if (existing.length > 0) {
          request.log.info(
            { messageId, id: existing[0]!.id },
            "inbound: duplicate message_id, skipping",
          );
          return reply.code(200).send({ accepted: true, duplicate: true });
        }
      }

      const result = await app.db.transaction(async (tx) => {
        const threadId = await resolveOrCreateThread(tx, {
          inReplyTo,
          referencesChain,
          subject,
          fromAddress: from.address,
          toAddress: to.address,
        });

        const [inserted] = await tx
          .insert(emailInbound)
          .values({
            threadId,
            messageId,
            inReplyTo,
            referencesChain: referencesChain.length > 0 ? referencesChain.join(" ") : null,
            fromAddress: from.address,
            fromName: from.name,
            toAddress: to.address,
            subject,
            textBody: fields.text,
            htmlBody: fields.html,
            attachmentsMeta: fields.attachments,
            rawHeaders: { raw: fields.headersRaw ?? "" },
            spamScore: spamScore,
            envelopeFrom,
          })
          .returning({ id: emailInbound.id });
        if (!inserted) throw new Error("email_inbound insert returned no row");

        // Bump thread counter + last_inbound_at. Cheaper than a
        // sub-select on the list view.
        await tx
          .update(emailThreads)
          .set({
            lastInboundAt: sql`NOW()`,
            inboundCount: sql`${emailThreads.inboundCount} + 1`,
          })
          .where(eq(emailThreads.id, threadId));

        return { id: inserted.id, threadId };
      });

      request.log.info(
        {
          inbound: result.id,
          thread: result.threadId,
          from: from.address,
          subject,
          spamScore,
        },
        "inbound: stored",
      );

      return reply.code(202).send({ accepted: true });
    },
  );
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return timingSafeEqual(ab, bb);
}

async function collectFields(
  request: import("fastify").FastifyRequest,
): Promise<SendGridFields> {
  const out: SendGridFields = {
    to: null,
    from: null,
    subject: null,
    text: null,
    html: null,
    headersRaw: null,
    envelope: null,
    spamScore: null,
    attachmentInfo: null,
    attachments: [],
  };

  for await (const part of request.parts()) {
    if (part.type === "field") {
      const value = typeof part.value === "string" ? part.value : "";
      switch (part.fieldname) {
        case "to":
          out.to = value;
          break;
        case "from":
          out.from = value;
          break;
        case "subject":
          out.subject = value;
          break;
        case "text":
          out.text = value;
          break;
        case "html":
          out.html = value;
          break;
        case "headers":
          out.headersRaw = value;
          break;
        case "envelope":
          out.envelope = value;
          break;
        case "spam_score":
          out.spamScore = value;
          break;
        case "attachment-info":
          out.attachmentInfo = value;
          break;
        default:
          // Drop unknown fields silently — SendGrid adds new ones
          // (charsets, sender_ip, etc.) that we don't care about.
          break;
      }
    } else {
      // File field — record metadata, consume the stream into /dev/null
      // so the connection doesn't stall. Future work: persist into a
      // blob store and reference here. For MVP, attachments are dropped.
      let size = 0;
      for await (const chunk of part.file) {
        size += (chunk as Buffer).length;
      }
      out.attachments.push({
        filename: part.filename,
        contentType: part.mimetype ?? null,
        sizeBytes: size,
      });
    }
  }

  return out;
}

function extractEnvelopeFrom(envelopeJson: string | null): string | null {
  if (!envelopeJson) return null;
  try {
    const parsed = JSON.parse(envelopeJson) as { from?: unknown };
    return typeof parsed.from === "string" ? parsed.from : null;
  } catch {
    return null;
  }
}
