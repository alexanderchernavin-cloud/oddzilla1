-- 0073_email.sql
--
-- Transactional email infrastructure. Three new tables + one column on
-- users — the minimal surface for signup verification and forgot-password
-- flows. Notification emails (bet won, withdrawal status, security alert)
-- pile onto the same outbox once the pipe is proven.
--
-- Why an outbox rather than firing the provider HTTP call from the route
-- handler:
--   * Atomic with the originating tx — the signup row, the verification
--     token, and the outbox enqueue commit together or not at all. We
--     never email a user whose row was rolled back; we never fail signup
--     because the email provider returned 503.
--   * Provider failures retry on their own cadence (worker sweeps every
--     30 s + LISTEN/NOTIFY for immediate drain). The route handler stays
--     fast; downstream provider degradation never bleeds into UX.
--   * Apply-once is one unique partial index, mirroring push_outbox and
--     wallet_ledger.
--
-- Why hash-only token storage:
--   * The raw token is sent to the user's inbox. If the DB is exfiltrated
--     later, the raw values must remain useless — same threat model as
--     password hashes.
--   * Verification on consumption is sha256(raw) → match against
--     token_hash. Constant-time compare not necessary because the table
--     lookup is by hash equality on an indexed BYTEA column.

BEGIN;

-- ── users.email_verified_at ─────────────────────────────────────────────
-- Nullable timestamp. NULL = never verified (or pending). Storefront
-- shows a banner; eventually we may gate certain actions (placing first
-- bet, deposit) on this being non-null, but for the first slice login
-- still works regardless so existing demo-OZ accounts aren't locked out
-- on next login.
ALTER TABLE users
  ADD COLUMN email_verified_at TIMESTAMPTZ;


-- ── email_outbox ────────────────────────────────────────────────────────
-- Durable queue of pending sends. Producer is whatever route handler
-- needs to email the user; consumer is the api process draining via
-- LISTEN/NOTIFY + 30 s sweep, dispatching to the configured provider.
--
-- Shape mirrors push_notifications_outbox so the two pipelines stay
-- visually consistent and the worker code can copy-paste the drain loop.
--
-- `kind` is open-ended TEXT (not enum) so new email types ship without
-- a migration. Today's kinds: `verify_email`, `password_reset`. Future:
-- `welcome`, `bet_won`, `withdrawal_confirmed`, `security_alert`.
--
-- `to_address` is captured at enqueue time rather than derefed from
-- users.email at send time so a later email-change doesn't silently
-- redirect an in-flight verification email.
--
-- `payload` carries template-specific data (verification URL, reset
-- URL, ticket details, etc.). The render layer reads it; the table
-- doesn't.
CREATE TABLE email_outbox (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL,
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  to_address   TEXT NOT NULL,
  subject      TEXT NOT NULL,
  payload      JSONB NOT NULL,
  -- Apply-once dedup key. For verify_email it's the token id; for
  -- password_reset it's the token id; for future ticket-derived
  -- notifications it'd be `bet_won:<ticket_id>`. Worker enforces
  -- per-kind semantics on its side; the unique partial index makes
  -- double-enqueue at the SQL layer a no-op.
  dedup_key    TEXT,
  enqueued_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at      TIMESTAMPTZ,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT
);

CREATE UNIQUE INDEX email_outbox_kind_dedup_unique
  ON email_outbox (kind, dedup_key)
  WHERE dedup_key IS NOT NULL;

CREATE INDEX email_outbox_pending_idx
  ON email_outbox (enqueued_at)
  WHERE sent_at IS NULL;

CREATE INDEX email_outbox_user_idx
  ON email_outbox (user_id, enqueued_at DESC)
  WHERE user_id IS NOT NULL;


-- ── email_verification_tokens ───────────────────────────────────────────
-- One row per outstanding verification link. Token raw value lives only
-- in the user's email; we store sha256 of it. Single-use: `used_at` is
-- stamped on consumption and re-presenting the same token 400s.
--
-- A user may have multiple unconsumed rows (signup + N resends). Any
-- valid hash unlocks; on consumption we DELETE every row for that user
-- so a leaked older token can't be replayed.
--
-- TTL is 24 h. Long enough for users who open the email next morning;
-- short enough that an exfiltrated table doesn't carry indefinite
-- access. The `expires_at` index supports the cleanup sweep.
CREATE TABLE email_verification_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   BYTEA NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT email_verification_tokens_hash_len
    CHECK (octet_length(token_hash) = 32)
);

-- Lookup by hash for the verify-email route. Unique because the hash
-- is from a 256-bit random source — collision is statistically zero,
-- and uniqueness lets us treat a successful lookup as definitive.
CREATE UNIQUE INDEX email_verification_tokens_hash_unique
  ON email_verification_tokens (token_hash);

-- Sweep-friendly partial index for pruning expired/used rows.
CREATE INDEX email_verification_tokens_expires_idx
  ON email_verification_tokens (expires_at)
  WHERE used_at IS NULL;


-- ── password_reset_tokens ───────────────────────────────────────────────
-- Same shape as verification tokens, shorter TTL (30 min) because a
-- reset link grants password-change ability which is more sensitive
-- than email-confirmation. Single-use; consumption stamps `used_at`
-- and also revokes every session for the user (route logic handles
-- that — no DB cascade needed).
--
-- A reset request always emits a token row regardless of whether the
-- email matches a user, BUT only enqueues an outbox row when it does.
-- The route always returns 200 either way to prevent account
-- enumeration. We don't insert sentinel rows for unknown emails —
-- the safest behaviour is "do nothing, return 200" and skip the DB
-- work entirely.
CREATE TABLE password_reset_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   BYTEA NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  requested_ip INET,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT password_reset_tokens_hash_len
    CHECK (octet_length(token_hash) = 32)
);

CREATE UNIQUE INDEX password_reset_tokens_hash_unique
  ON password_reset_tokens (token_hash);

CREATE INDEX password_reset_tokens_expires_idx
  ON password_reset_tokens (expires_at)
  WHERE used_at IS NULL;

COMMIT;
