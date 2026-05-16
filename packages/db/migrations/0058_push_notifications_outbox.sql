-- 0058_push_notifications_outbox.sql
--
-- Outbox for FCM push notifications. Settlement (Go) writes a row in the
-- same transaction that flips a winning ticket to `settled`, then fires
-- `pg_notify('push_outbox')` after commit. The api service (TS) LISTENs
-- on that channel, picks up pending rows, and sends them via the Firebase
-- Admin SDK. A 30 s periodic sweep on the api side catches anything missed
-- (api restart, missed NOTIFY, transient Firebase error).
--
-- Why an outbox rather than firing FCM directly from Go:
--   * Atomic with the settle tx — a successful settle either commits the
--     push intent or rolls back with it. We never push for a ticket whose
--     settle failed, and we never lose a push for a ticket that did settle.
--   * Firebase Admin SDK only ships for Node / Python / Java / Go. We
--     keep the credential blast radius on a single container (api) instead
--     of mounting the service-account JSON into every Go worker.
--   * Retries + visibility for free — sent_at IS NULL is the work queue,
--     attempts + last_error are the diagnostic surface.
--
-- Why a unique partial index on (kind, ticket_id) WHERE ticket_id IS NOT NULL:
--   * Apply-once on settlement replay. The wallet_ledger row is also
--     deduped by ref_id, so the second settle attempt for the same ticket
--     is a no-op there; we want the same shape here so a replay doesn't
--     re-push.
--   * Partial because future non-ticket kinds (cashout_offered,
--     bet_inspired) will need their own idempotency keys carried in the
--     payload — we model them as ticket_id IS NULL and let the worker
--     enforce a per-kind dedup on its side.

BEGIN;

CREATE TABLE push_notifications_outbox (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  ticket_id    UUID REFERENCES tickets(id) ON DELETE CASCADE,
  payload      JSONB NOT NULL,
  enqueued_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at      TIMESTAMPTZ,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT
);

-- Apply-once for ticket-derived pushes. Mirrors the wallet_ledger
-- `(type, ref_type, ref_id) WHERE ref_id IS NOT NULL` shape.
CREATE UNIQUE INDEX push_outbox_kind_ticket_unique
  ON push_notifications_outbox (kind, ticket_id)
  WHERE ticket_id IS NOT NULL;

-- The worker scans pending rows by enqueued_at; partial index keeps the
-- scan tiny since the table is append-mostly and sent rows are pruned.
CREATE INDEX push_outbox_pending_idx
  ON push_notifications_outbox (enqueued_at)
  WHERE sent_at IS NULL;

COMMIT;
