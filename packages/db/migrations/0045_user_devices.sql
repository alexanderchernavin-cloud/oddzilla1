-- 0045_user_devices.sql
--
-- Push-notification device registry. The mobile app registers its FCM
-- token here on first launch (after login); the API uses the table to
-- fan out per-user pushes (bet settled, cashout offered, copy-bet
-- inspiration, etc.) once the Firebase Admin SDK is wired into the
-- api service.
--
-- Why one row per (user_id, token):
--   • A user can have several devices (phone + tablet + factory-reset
--     same phone). Each device's FCM token is unique. Adding a
--     composite UNIQUE means the register endpoint is a clean upsert
--     with ON CONFLICT (user_id, token) DO UPDATE SET last_seen_at = NOW().
--
-- Why `revoked_at` instead of hard-deleting on logout:
--   • A user can log out on phone A and back in on phone B; we need
--     to keep B's row hot. Hard-delete on logout would create a delete
--     storm on shared devices. Soft-revoke is one UPDATE per logout,
--     and the push-sender filters `WHERE revoked_at IS NULL`.
--
-- Why `platform` is just text, not an enum:
--   • Platforms beyond android show up over time (ios, web-push, …)
--     and ENUM evolution is more friction than the constraint is
--     worth. CHECK constraint enforces the current allowlist; new
--     values land in a one-line ALTER without a type migration.

BEGIN;

CREATE TABLE user_devices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token         TEXT NOT NULL,
  platform      TEXT NOT NULL,
  app_version   TEXT,
  device_label  TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ,
  CONSTRAINT user_devices_user_token_unique UNIQUE (user_id, token),
  CONSTRAINT user_devices_platform_allowlist CHECK (platform IN ('android', 'ios', 'web'))
);

-- Per-user lookup of live tokens for the push-sender. Partial index so
-- revoked rows don't bloat scan size — the table is append-mostly,
-- with revocation being the rare path.
CREATE INDEX user_devices_user_active_idx
  ON user_devices(user_id)
  WHERE revoked_at IS NULL;

-- Cross-user token lookup. Two users sharing a hand-me-down phone can
-- both register the same FCM token — we revoke the prior owner on the
-- next register so a stale account doesn't keep receiving someone
-- else's pushes.
CREATE INDEX user_devices_token_idx ON user_devices(token);

COMMIT;
