// Email-outbox drainer.
//
// Subscribes via postgres LISTEN to the `email_outbox` channel
// (route handlers / enqueue helpers fire NOTIFY after insert) and falls
// back to a 30 s periodic sweep so a missed notify (api restart,
// LISTEN drop) doesn't strand pending sends.
//
// Mirrors services/api/src/modules/push/worker.ts shape — same drain
// loop, same FOR UPDATE SKIP LOCKED, same MAX_ATTEMPTS cap. The only
// differences are kind-specific render dispatch and that the consumer
// is HTTPS-to-an-email-provider rather than HTTPS-to-FCM.
//
// Graceful-idle: when no email client resolves (token absent / provider
// unconfigured), every pending row is marked sent with
// `last_error=email_disabled`. The table size stays bounded; flipping
// the env var on later just restarts the worker.

import type { FastifyInstance } from "fastify";
import { loadEnv } from "@oddzilla/config";
import { resolveEmailClient, emailProviderSummary, type EmailClient } from "./client.js";
import {
  renderAdminMessage,
  renderPasswordReset,
  renderVerifyEmail,
  type PasswordResetPayload,
  type VerifyEmailPayload,
  type RenderedEmail,
} from "./render.js";

const NOTIFY_CHANNEL = "email_outbox";
const SWEEP_INTERVAL_MS = 30_000;
const DRAIN_BATCH = 25;
const MAX_ATTEMPTS = 5;

interface PendingRow {
  id: string; // bigint serialized to string by postgres.js
  kind: string;
  user_id: string | null;
  to_address: string;
  subject: string;
  payload: Record<string, unknown>;
  text_body: string | null;
  html_body: string | null;
  in_reply_to: string | null;
  thread_id: string | null;
  attempts: number;
}

export interface EmailWorkerHandle {
  close(): Promise<void>;
}

export async function startEmailOutboxWorker(app: FastifyInstance): Promise<EmailWorkerHandle> {
  const sql = app.sql;
  const env = loadEnv();
  const client = resolveEmailClient();
  let stopped = false;
  let draining = false;
  let pendingWake = false;

  const triggerDrain = () => {
    if (stopped) return;
    if (draining) {
      pendingWake = true;
      return;
    }
    void drain().catch((err) => {
      app.log.warn({ err: (err as Error).message }, "email: drain failed");
    });
  };

  async function drain(): Promise<void> {
    draining = true;
    try {
      for (;;) {
        const rows = await claimBatch();
        if (rows.length === 0) {
          if (pendingWake) {
            pendingWake = false;
            continue;
          }
          break;
        }
        for (const row of rows) {
          try {
            await processRow(row, client);
          } catch (err) {
            await recordFailure(row, (err as Error).message);
          }
        }
      }
    } finally {
      draining = false;
    }
  }

  async function claimBatch(): Promise<PendingRow[]> {
    return sql<PendingRow[]>`
      SELECT id::text AS id,
             kind,
             user_id::text AS user_id,
             to_address,
             subject,
             payload,
             text_body,
             html_body,
             in_reply_to,
             thread_id::text AS thread_id,
             attempts
        FROM email_outbox
       WHERE sent_at IS NULL
       ORDER BY enqueued_at
       LIMIT ${DRAIN_BATCH}
       FOR UPDATE SKIP LOCKED
    `;
  }

  async function processRow(row: PendingRow, client: EmailClient | null): Promise<void> {
    // Graceful-idle: no provider configured → drain row so the queue
    // doesn't grow unbounded. Operator sees the state in boot log and
    // in per-row last_error.
    if (!client) {
      await markSent(row.id, "email_disabled", null);
      return;
    }

    const rendered = renderForKind(row);
    if (!rendered) {
      await markSent(row.id, `unsupported_kind:${row.kind}`, null);
      return;
    }

    const result = await client.send({
      to: row.to_address,
      subject: row.subject,
      html: rendered.html,
      text: rendered.text,
      from: env.EMAIL_FROM,
      replyTo: env.EMAIL_REPLY_TO,
      inReplyTo: row.in_reply_to ?? undefined,
    });

    await markSent(row.id, null, result.providerMessageId);

    // For admin-initiated kinds, bump the thread's outbound counter
    // and last_outbound_at so the inbox list reorders. Built-in kinds
    // (verify_email, password_reset) don't carry a thread_id today.
    if (row.thread_id && (row.kind === "admin_outbound" || row.kind === "admin_reply")) {
      await sql`
        UPDATE email_threads
           SET last_outbound_at = NOW(),
               outbound_count = outbound_count + 1
         WHERE id = ${row.thread_id}::uuid
      `;
    }

    app.log.debug(
      { id: row.id, kind: row.kind, to: row.to_address, providerId: result.providerMessageId },
      "email: sent",
    );
  }

  function renderForKind(row: PendingRow): RenderedEmail | null {
    switch (row.kind) {
      case "verify_email":
        return renderVerifyEmail(row.payload as unknown as VerifyEmailPayload);
      case "password_reset":
        return renderPasswordReset(row.payload as unknown as PasswordResetPayload);
      case "admin_outbound":
      case "admin_reply":
        // Admin-authored bodies live on the row directly. Missing
        // bodies are a bug in the enqueue path; render an empty body
        // so the email goes out as a no-content shell rather than
        // throwing and retrying forever.
        return renderAdminMessage({
          subject: row.subject,
          textBody: row.text_body ?? "",
          htmlBody: row.html_body ?? null,
        });
      default:
        return null;
    }
  }

  async function markSent(
    id: string,
    lastError: string | null,
    providerMessageId: string | null,
  ): Promise<void> {
    await sql`
      UPDATE email_outbox
         SET sent_at = NOW(),
             attempts = attempts + 1,
             last_error = ${lastError},
             provider_message_id = COALESCE(${providerMessageId}, provider_message_id)
       WHERE id = ${id}::bigint
    `;
  }

  async function recordFailure(row: PendingRow, message: string): Promise<void> {
    const nextAttempts = row.attempts + 1;
    if (nextAttempts >= MAX_ATTEMPTS) {
      await sql`
        UPDATE email_outbox
           SET sent_at = NOW(),
               attempts = ${nextAttempts},
               last_error = ${`max_attempts:${message}`.slice(0, 1000)}
         WHERE id = ${row.id}::bigint
      `;
      app.log.warn(
        { id: row.id, kind: row.kind, attempts: nextAttempts, err: message },
        "email: giving up after max attempts",
      );
      return;
    }
    await sql`
      UPDATE email_outbox
         SET attempts = ${nextAttempts},
             last_error = ${message.slice(0, 1000)}
       WHERE id = ${row.id}::bigint
    `;
    app.log.debug(
      { id: row.id, kind: row.kind, attempts: nextAttempts, err: message },
      "email: transient failure, will retry",
    );
  }

  const listenHandle = await sql.listen(NOTIFY_CHANNEL, () => {
    triggerDrain();
  });

  const sweepTimer = setInterval(triggerDrain, SWEEP_INTERVAL_MS);
  triggerDrain();

  app.log.info(
    {
      provider: emailProviderSummary(),
      sweepMs: SWEEP_INTERVAL_MS,
      batch: DRAIN_BATCH,
    },
    "email: outbox worker started",
  );

  return {
    async close() {
      stopped = true;
      clearInterval(sweepTimer);
      try {
        await listenHandle.unlisten?.();
      } catch {
        // ignore — shutdown
      }
    },
  };
}
