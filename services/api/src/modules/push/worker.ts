// Push-outbox worker.
//
// Subscribes via postgres LISTEN to the `push_outbox` channel (settlement
// fires NOTIFY after every winning-ticket commit) and falls back to a
// 30 s periodic sweep so a missed notify (api restart, network blip,
// rare LISTEN drop) doesn't strand pending pushes.
//
// Concurrency model: a single api process drains. If we ever run more
// than one api container the SELECT...FOR UPDATE SKIP LOCKED keeps the
// drain race-free across processes. Per-drain cap (PUSH_DRAIN_BATCH)
// bounds the per-call worst-case time + memory.
//
// Failure handling: each row carries an `attempts` counter and a
// `last_error` string. Transient FCM failures (5xx, network) bump
// attempts and leave `sent_at` NULL so the next sweep retries. After
// MAX_ATTEMPTS the row is force-marked sent with last_error preserved
// so the operator can audit but the worker stops thrashing on it.
// Per-token errors that mean "this token is dead" (invalid argument,
// not registered) soft-revoke the matching user_devices row instead of
// failing the whole push.
//
// Idle mode: when Firebase isn't configured (no service-account JSON
// mounted) the worker still runs but marks every row sent with
// last_error='firebase_disabled'. That drains the queue so the operator
// sees the table size stays bounded; flipping the env var on later
// just restarts and future settlements push for real.

import type { FastifyInstance } from "fastify";
import {
  firebaseCredentialPath,
  firebaseInitError,
  getMessaging,
  isFirebaseEnabled,
} from "./firebase.js";
import { loadTicketLabels } from "./labels.js";
import { renderBetWon, type BetWonPayload } from "./render.js";

const NOTIFY_CHANNEL = "push_outbox";
const SWEEP_INTERVAL_MS = 30_000;
const DRAIN_BATCH = 50;
const MAX_ATTEMPTS = 5;

interface PendingRow {
  id: string; // bigint serialized to string by postgres.js
  user_id: string;
  kind: string;
  ticket_id: string | null;
  payload: BetWonPayload;
  attempts: number;
}

interface DeviceRow {
  id: string;
  token: string;
}

export interface PushWorkerHandle {
  close(): Promise<void>;
}

export async function startPushOutboxWorker(app: FastifyInstance): Promise<PushWorkerHandle> {
  const sql = app.sql;
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
      app.log.warn({ err: (err as Error).message }, "push: drain failed");
    });
  };

  async function drain(): Promise<void> {
    draining = true;
    try {
      // Loop until SELECT returns no rows; in practice we'll usually only
      // do one round but a backlog after restart can need several batches.
      // The pendingWake re-entry handles incoming NOTIFYs during a drain.
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
            await processRow(row);
          } catch (err) {
            await recordFailure(row, (err as Error).message);
          }
        }
      }
    } finally {
      draining = false;
    }
  }

  // claimBatch returns the next DRAIN_BATCH pending rows. SKIP LOCKED
  // keeps a future multi-process api from double-processing.
  async function claimBatch(): Promise<PendingRow[]> {
    return sql<PendingRow[]>`
      SELECT id::text AS id,
             user_id,
             kind,
             ticket_id::text AS ticket_id,
             payload,
             attempts
        FROM push_notifications_outbox
       WHERE sent_at IS NULL
       ORDER BY enqueued_at
       LIMIT ${DRAIN_BATCH}
       FOR UPDATE SKIP LOCKED
    `;
  }

  async function processRow(row: PendingRow): Promise<void> {
    // Idle mode: Firebase off → mark sent immediately so the queue drains.
    if (!isFirebaseEnabled()) {
      await markSent(row.id, "firebase_disabled");
      return;
    }
    if (row.kind !== "bet_won") {
      // Future kinds land here as no-op so we never silently retain an
      // unknown payload — mark sent with the kind in last_error.
      await markSent(row.id, `unsupported_kind:${row.kind}`);
      return;
    }
    const messaging = await getMessaging();
    if (!messaging) {
      const initErr = firebaseInitError();
      await markSent(row.id, initErr ? `firebase_init_failed:${initErr}` : "firebase_unavailable");
      return;
    }

    const devices = await loadActiveDevices(row.user_id);
    if (devices.length === 0) {
      // No live devices — nothing to push. Mark sent so the row doesn't
      // come back on every sweep; the user will see the win in-app.
      await markSent(row.id, "no_devices");
      return;
    }

    // Fetch human-readable labels (home/away teams, market name, outcome
    // name) so the push body can read "<home> vs <away> — <outcome>"
    // instead of a raw stake/payout line. Best-effort: an empty array
    // makes renderBetWon fall back to the money-only summary.
    const labels = await loadTicketLabels(sql, row.payload.ticketId).catch(
      (err) => {
        app.log.debug({ err: (err as Error).message, ticket: row.ticket_id },
          "push: label lookup failed; rendering without labels");
        return [];
      },
    );
    const rendered = renderBetWon(row.payload, labels);
    const tokens = devices.map((d) => d.token);
    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: rendered.title,
        body: rendered.body,
      },
      data: rendered.data,
      android: {
        priority: "high",
        notification: {
          // Channel id must match cc.oddzilla.app.fcm.FcmService — see
          // FcmService.kt.example which creates the `oddzilla-default`
          // NotificationChannel on first message.
          channelId: "oddzilla-default",
        },
      },
    });

    // Reap dead tokens. Errors that mean "this token is gone" must be
    // soft-revoked in user_devices so we stop sending to them; transient
    // errors (server error, unavailable) leave the device alone — the
    // app will refresh tokens on its own cadence.
    for (let i = 0; i < response.responses.length; i++) {
      const r = response.responses[i]!;
      if (r.success) continue;
      const code = r.error?.code ?? "";
      if (DEAD_TOKEN_CODES.has(code)) {
        await revokeDevice(devices[i]!.id, code);
      }
    }

    if (response.failureCount === response.responses.length && response.successCount === 0) {
      // Every recipient errored. Don't mark sent — retry next pass unless
      // all errors are dead-token codes (in which case the device list
      // will be empty on the retry and we'll mark sent then).
      const allDeadTokens = response.responses.every((r) => {
        if (r.success) return false;
        return DEAD_TOKEN_CODES.has(r.error?.code ?? "");
      });
      if (allDeadTokens) {
        await markSent(row.id, "all_tokens_dead");
        return;
      }
      throw new Error(`all-fail fcm dispatch: ${response.responses[0]?.error?.message ?? "unknown"}`);
    }
    await markSent(row.id, null);
  }

  async function loadActiveDevices(userId: string): Promise<DeviceRow[]> {
    return sql<DeviceRow[]>`
      SELECT id::text AS id, token
        FROM user_devices
       WHERE user_id = ${userId}
         AND revoked_at IS NULL
    `;
  }

  async function markSent(id: string, lastError: string | null): Promise<void> {
    await sql`
      UPDATE push_notifications_outbox
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
        UPDATE push_notifications_outbox
           SET sent_at = NOW(),
               attempts = ${nextAttempts},
               last_error = ${`max_attempts:${message}`.slice(0, 1000)}
         WHERE id = ${row.id}::bigint
      `;
      app.log.warn(
        { ticket: row.ticket_id, attempts: nextAttempts, err: message },
        "push: giving up after max attempts",
      );
      return;
    }
    await sql`
      UPDATE push_notifications_outbox
         SET attempts = ${nextAttempts},
             last_error = ${message.slice(0, 1000)}
       WHERE id = ${row.id}::bigint
    `;
    app.log.debug(
      { ticket: row.ticket_id, attempts: nextAttempts, err: message },
      "push: transient failure, will retry",
    );
  }

  async function revokeDevice(deviceId: string, reason: string): Promise<void> {
    await sql`
      UPDATE user_devices
         SET revoked_at = NOW()
       WHERE id = ${deviceId}::uuid
         AND revoked_at IS NULL
    `;
    app.log.info({ deviceId, reason }, "push: revoked dead token");
  }

  // Subscribe to LISTEN. postgres.js manages a dedicated connection for
  // listening — no manual reconnect handling needed; the driver re-LISTENs
  // after any underlying disconnect.
  const listenHandle = await sql.listen(NOTIFY_CHANNEL, () => {
    triggerDrain();
  });

  // Periodic sweep — catches missed notifies (rare) and lets us boot
  // with a non-empty queue. Also drains the queue on startup.
  const sweepTimer = setInterval(triggerDrain, SWEEP_INTERVAL_MS);
  // Drain immediately so a backlog accumulated while the api was down
  // gets serviced as soon as we boot.
  triggerDrain();

  // Boot diagnostic: report the resolved Firebase state so a missing
  // service-account JSON is obvious from the very first log line, not
  // buried in per-row outbox last_error values after pushes start failing.
  const credPath = firebaseCredentialPath();
  const fbEnabled = isFirebaseEnabled();
  const fbState =
    credPath == null
      ? "disabled (no credential env)"
      : fbEnabled
        ? "enabled"
        : `unusable (path=${credPath}, file missing — drop the Firebase Admin SDK service-account JSON there)`;
  app.log.info(
    {
      firebase: fbState,
      sweepMs: SWEEP_INTERVAL_MS,
      batch: DRAIN_BATCH,
    },
    "push: outbox worker started",
  );

  return {
    async close() {
      stopped = true;
      clearInterval(sweepTimer);
      try {
        // postgres.js listen() returns { unlisten }
        await listenHandle.unlisten?.();
      } catch {
        // ignore — shutdown
      }
    },
  };
}

// FCM v1 error codes that indicate the token is permanently invalid:
// the recipient app is gone, the token never existed, or the project
// rejected it. Anything else (rate limit, server error, network) is
// transient and we leave the device row alone.
const DEAD_TOKEN_CODES = new Set<string>([
  "messaging/invalid-argument",
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
  "messaging/mismatched-credential",
]);
