-- 0074_email_inbound.sql
--
-- Inbound email — backoffice inbox + threading. Companion to 0073's
-- outbound pipeline. SendGrid Inbound Parse POSTs each received message
-- to /webhooks/sendgrid-inbound/<secret>; we persist it here and group
-- messages into threads.
--
-- Threading model is RFC 5322 standard:
--   1. New message: no In-Reply-To header → start a new thread (or
--      match by normalised subject if the user manually replied to one
--      of our prior sends, which our outbound carries Message-ID for).
--   2. Reply: In-Reply-To header points at the Message-ID of one of our
--      prior outbound messages (captured in email_outbox.provider_message_id)
--      OR a prior inbound message → attach to that thread.
--   3. References header is the chain — we walk it from newest to
--      oldest until we find a known message; that thread wins.
--
-- We extend email_outbox with thread_id + provider_message_id so the
-- outbound side participates in threading (admin replies AND the system's
-- verify/reset emails — a user replying to a verify email lands in a
-- thread we can attribute to the user).

BEGIN;

-- ── email_threads ──────────────────────────────────────────────────────
-- One row per conversation. Subject is the first inbound message's
-- subject (or first outbound for admin-initiated threads), captured at
-- thread creation; subsequent messages may differ in casing/prefix and
-- we keep the original.
--
-- Counters + last_*_at are maintained by the webhook handler (inbound)
-- and the email worker (outbound) so listing threads doesn't aggregate
-- across messages on every request.
CREATE TABLE email_threads (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject            TEXT NOT NULL,
  -- Normalised version of the subject — strip leading "Re: ", "Fwd: ",
  -- collapse whitespace, lowercase. Used as a last-resort thread match
  -- when no In-Reply-To/References can be resolved.
  normalised_subject TEXT NOT NULL,
  -- The first inbound address that hit this thread, captured for
  -- list-view display ("from someone@example.com — 3 messages").
  first_from         TEXT,
  first_to           TEXT,
  last_inbound_at    TIMESTAMPTZ,
  last_outbound_at   TIMESTAMPTZ,
  inbound_count      INTEGER NOT NULL DEFAULT 0,
  outbound_count     INTEGER NOT NULL DEFAULT 0,
  -- Soft-archive. Archived threads stay in the DB but drop from the
  -- default inbox view. No "delete" — every conversation is potentially
  -- compliance-relevant.
  archived_at        TIMESTAMPTZ,
  -- Optional assignment so multi-operator setups can divide work.
  -- Nullable; today we always render every thread to every admin.
  assigned_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX email_threads_last_activity_idx
  ON email_threads (GREATEST(COALESCE(last_inbound_at, created_at), COALESCE(last_outbound_at, created_at)) DESC);

-- Subject-based thread match needs a fast lookup keyed on the
-- normalised subject. Partial index excludes archived threads since
-- a reply to a long-archived conversation should usually start a new
-- thread (the operator can re-link manually if needed).
CREATE INDEX email_threads_normalised_subject_idx
  ON email_threads (normalised_subject)
  WHERE archived_at IS NULL;

CREATE INDEX email_threads_archived_at_idx
  ON email_threads (archived_at)
  WHERE archived_at IS NOT NULL;


-- ── email_inbound ──────────────────────────────────────────────────────
-- One row per received message. Bodies are stored inline (text + html)
-- rather than blob-referenced because the volume is tiny (handful per
-- week MVP) and admin viewing is faster without a second fetch.
--
-- Attachments are not persisted in this first slice — the JSONB column
-- stores metadata only (filename, content_type, size) for visibility;
-- if we add real attachment storage later it'll be a blob ref in this
-- same column. SendGrid Inbound Parse delivers attachments as multipart
-- file uploads which we currently DROP at the webhook layer.
--
-- spam_score / spam_report are best-effort SendGrid annotations. They
-- aren't used as a gate today — every inbound message lands in the
-- inbox regardless — but they're available for future filtering.
CREATE TABLE email_inbound (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id          UUID NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
  -- Apply-once on webhook retry. SendGrid will retry a 5xx response;
  -- the unique index on the message id keeps re-deliveries idempotent.
  -- NULL is allowed for the rare case a sender omits Message-ID; we
  -- accept those but they can't be deduped on replay (operator would
  -- see the message twice if SendGrid retries). Unique partial index
  -- below enforces uniqueness only when present.
  message_id         TEXT,
  in_reply_to        TEXT,
  references_chain   TEXT,
  from_address       TEXT NOT NULL,
  from_name          TEXT,
  to_address         TEXT NOT NULL,
  subject            TEXT NOT NULL,
  text_body          TEXT,
  html_body          TEXT,
  attachments_meta   JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_headers        JSONB NOT NULL DEFAULT '{}'::jsonb,
  spam_score         NUMERIC(5,2),
  -- SendGrid envelope.from — the SMTP-level sender, which can differ
  -- from the From: header (forwarders, mailing lists). Captured for
  -- forensics; the UI shows the header From.
  envelope_from      TEXT,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at            TIMESTAMPTZ,
  read_by_user_id    UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX email_inbound_message_id_unique
  ON email_inbound (message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX email_inbound_thread_received_idx
  ON email_inbound (thread_id, received_at DESC);

CREATE INDEX email_inbound_unread_idx
  ON email_inbound (received_at DESC)
  WHERE read_at IS NULL;


-- ── email_outbox extensions ────────────────────────────────────────────
-- Threading: outbound messages participate in threads so the inbox view
-- can interleave inbound + outbound chronologically. The kind set grows
-- to include admin_outbound (new conversation) and admin_reply (reply
-- within an existing thread).
--
-- provider_message_id is what the email provider returned as the SMTP
-- Message-ID for our outbound send. We capture it so a future inbound
-- reply carrying In-Reply-To=<that-id> can be threaded to the right
-- conversation.
--
-- text_body / html_body lift the bodies up from `payload` for the new
-- admin kinds where the body is the entire content (not a templated
-- render). Existing verify_email / password_reset rows keep using
-- `payload` for url + displayName; they don't write these two columns.
ALTER TABLE email_outbox
  ADD COLUMN thread_id              UUID REFERENCES email_threads(id) ON DELETE SET NULL,
  ADD COLUMN provider_message_id    TEXT,
  ADD COLUMN text_body              TEXT,
  ADD COLUMN html_body              TEXT,
  -- The Message-ID our outbound message will REFERENCE in its
  -- In-Reply-To header (an admin replying to an inbound). NULL = no
  -- threading hint.
  ADD COLUMN in_reply_to             TEXT;

CREATE INDEX email_outbox_thread_sent_idx
  ON email_outbox (thread_id, sent_at)
  WHERE thread_id IS NOT NULL;

-- Threading lookup: "does any outbound message I've sent carry this
-- Message-ID?" This is what the inbound webhook walks against in
-- In-Reply-To / References resolution. Provider message ids are
-- 1-per-row by definition, so unique is safe + helpful.
CREATE UNIQUE INDEX email_outbox_provider_message_id_unique
  ON email_outbox (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

COMMIT;
