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
      await markSent(row.id, "email_disabled");
      return;
    }

    const rendered = renderForKind(row);
    if (!rendered) {
      await markSent(row.id, `unsupported_kind:${row.kind}`);
      return;
    }

    await client.send({
      to: row.to_address,
      subject: row.subject,
      html: rendered.html,
      text: rendered.text,
      from: env.EMAIL_FROM,
      replyTo: env.EMAIL_REPLY_TO,
    });
    await markSent(row.id, null);
    app.log.debug(
      { id: row.id, kind: row.kind, to: row.to_address },
      "email: sent",
    );
  }

  function renderForKind(row: PendingRow): RenderedEmail | null {
    switch (row.kind) {
      case "verify_email":
        return renderVerifyEmail(row.payload as unknown as VerifyEmailPayload);
      case "password_reset":
        return renderPasswordReset(row.payload as unknown as PasswordResetPayload);
      default:
        return null;
    }
  }

  async function markSent(id: string, lastError: string | null): Promise<void> {
    await sql`
      UPDATE email_outbox
         SET sent_at = NOW(),
             attempts = attempts + 1,
             last_error = ${lastError}
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
