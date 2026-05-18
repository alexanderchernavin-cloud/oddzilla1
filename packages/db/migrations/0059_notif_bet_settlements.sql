-- 0059_notif_bet_settlements.sql
--
-- Surfaces bet settlements (wins + cashouts) in the in-app notification
-- bell on the web. Migration 0044's preamble said the sportsbook owns
-- the settlement-feedback channel, not Community — that decision was
-- partially overridden by 0058_push_notifications_outbox.sql which
-- ships FCM mobile push for `bet_won`. This migration completes the
-- parity story for web users: the bell now carries the same signals
-- the mobile push covers.
--
-- Scope: only POSITIVE outcomes (won, cashed_out). Losing-bet
-- notifications are intentionally out of scope — they're widely seen
-- as friction in B2C sportsbooks, and adding them later behind the
-- same `pref_bet_settlements` toggle is a single follow-up commit.
--
-- Trigger sites:
--   * bet_won — services/settlement (Go) writes directly into
--     user_notifications inside the same SettleTicket tx, mirroring
--     the EnqueueBetWonPush pattern that 0058 added for FCM. Apply-
--     once via a group_key of `bet_won:<ticket_id>` and the existing
--     user_notifications_group_idx covers the dedup probe.
--   * bet_cashed_out — services/api/src/modules/cashout (TS) calls
--     emitNotification() after the cashout tx commits. The cashout
--     wallet update is already atomically applied; a notification
--     failure must not unwind it.
--
-- Why not also write bet_cashed_out through the push_outbox:
--   * That table is the FCM dispatch queue. We're surfacing in-app,
--     not mobile-push, on the cashout path for V1. When FCM ships
--     bet_cashed_out push, the cashout service will enqueue a row
--     there as well — same pattern, no schema change required.
--
-- Pref defaults TRUE because settlement is a wallet-affecting event,
-- not a social one — most users want this on. Per the same lockstep
-- rule as 0044, DEFAULT_PREFS in
-- services/api/src/modules/community/notifications.ts is updated in
-- the same PR.

-- Step 1: extend the enum. Postgres requires ALTER TYPE ... ADD VALUE
-- to run outside an explicit BEGIN/COMMIT (each ADD VALUE is its own
-- implicit tx); the custom migrate.ts runner reads each .sql file
-- whole without wrapping, so this is safe here.

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'bet_won';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'bet_cashed_out';

-- Step 2: add the pref column. Wrapped in its own tx so the column
-- add + default are atomic. No backfill needed — existing rows pick
-- up the DEFAULT TRUE on read (any user without a row reads
-- DEFAULT_PREFS in code, which is updated in lockstep).

BEGIN;

ALTER TABLE user_preferences
  ADD COLUMN pref_bet_settlements BOOLEAN NOT NULL DEFAULT TRUE;

COMMIT;
