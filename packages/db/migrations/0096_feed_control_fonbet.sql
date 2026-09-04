-- 0096_feed_control_fonbet
--
-- Runtime on/off switch for the Fonbet KZ feed (services/fonbet-ingester),
-- driven from /admin/feed next to the Oddin feed source switch.
--
-- Until now the only gate was FONBET_ENABLED in .env, read once at boot —
-- turning the second provider off meant editing .env and recreating the
-- container. The switch joins the feed_control singleton (migration 0095)
-- for the same reason that row exists: operator state must live in
-- Postgres, not in the allkeys-lru Redis cache.
--
-- fonbet_enabled is NULLABLE on purpose: NULL = "never switched from the
-- backoffice, follow the FONBET_ENABLED env default", TRUE / FALSE = the
-- operator's explicit position, which wins over env and survives restarts
-- and deploys. fonbet-ingester reads the row every 2 s; on FALSE it
-- suspends every Fonbet market (status -1, prices kept) and stops polling
-- Fonbet, on TRUE it boots the feed and re-activates whatever is still
-- quoted. fonbet_applied_* is its acknowledgement for the card.

ALTER TABLE feed_control
  ADD COLUMN IF NOT EXISTS fonbet_enabled         BOOLEAN,
  ADD COLUMN IF NOT EXISTS fonbet_switched_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fonbet_switched_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fonbet_applied_enabled BOOLEAN,
  ADD COLUMN IF NOT EXISTS fonbet_applied_at      TIMESTAMPTZ;

COMMENT ON COLUMN feed_control.fonbet_enabled IS
  'Operator switch for the Fonbet feed: NULL = follow FONBET_ENABLED env default, TRUE/FALSE = explicit position (wins over env). Read every 2 s by fonbet-ingester.';
COMMENT ON COLUMN feed_control.fonbet_applied_enabled IS
  'What fonbet-ingester last applied (TRUE = polling Fonbet, FALSE = catalog suspended and idle), for the backoffice card.';
