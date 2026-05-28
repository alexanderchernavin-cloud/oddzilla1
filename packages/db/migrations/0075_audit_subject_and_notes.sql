-- 0075_audit_subject_and_notes.sql
--
-- Two related additions for per-bettor admin visibility:
--
--   1. admin_audit_log.subject_user_id — the user being acted on, when
--      that user isn't the actor. Already present in many rows via
--      `target_type='user'` / `target_id=<userId>` (e.g. role / status
--      / limit / bet-delay / risk-score / balance / zillapass-stage
--      mutations), but per-bettor odds-adjustment + promo-visibility
--      writes use `target_type='bettor_odds_adjustment_config'` /
--      `'bettor_promo_visibility_config'` with `target_id` pointing
--      at the override row, not the bettor — so "all changes affecting
--      bettor X" isn't queryable from target_id alone.
--
--      Denormalises the subject userId into a dedicated column with a
--      partial index, so the new GET /admin/users/:id/audit-log can
--      filter in one indexed scan. Backfills from existing rows.
--
--      The audit-log hash chain (migration 0026) only covers actor +
--      action + target + before/after + ip + created_at — adding a
--      column does NOT break the chain. The verifier is unaffected;
--      pre-existing row_hash values still verify.
--
--   2. users.notes — free-text per-bettor operator notes, surfaced on
--      the RiskZilla bettor page. Plain text, capped at 4000 chars.

ALTER TABLE admin_audit_log
    ADD COLUMN subject_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX admin_audit_subject_idx
    ON admin_audit_log (subject_user_id, created_at DESC)
    WHERE subject_user_id IS NOT NULL;

-- Backfill from existing rows. Three sources cover every per-bettor
-- mutation that currently writes admin_audit_log:
--
--   a) target_type = 'user', target_id is a UUID
--      (user.update, user.create, user.delete, wallet.adjust,
--       zillapass.stage.override, zillapass.user_stage,
--       riskzilla.bettor.risk_score_update, …)
--
--   b) odds-adjustment rows: target_id like 'user:<uuid>:…'
--      (bettor_odds_adjustment.*)
--
--   c) promo-visibility rows: target_id like 'user:<uuid>:…'
--      (bettor_promo_visibility.*)
--
-- For (b) and (c) we extract the UUID from the prefix. The substring
-- is guaranteed to be a valid UUID by the writer (every call site
-- formats `user:${userId}:…` from a zod-validated UUID), but we still
-- gate on the canonical-uuid regex to be robust against any
-- hand-written / malformed row that snuck in.

UPDATE admin_audit_log
   SET subject_user_id = target_id::uuid
 WHERE subject_user_id IS NULL
   AND target_type = 'user'
   AND target_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

UPDATE admin_audit_log
   SET subject_user_id = substring(target_id from 6 for 36)::uuid
 WHERE subject_user_id IS NULL
   AND target_type IN (
       'bettor_odds_adjustment_config',
       'bettor_promo_visibility_config'
   )
   AND target_id ~ '^user:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:';

ALTER TABLE users
    ADD COLUMN notes TEXT;

ALTER TABLE users
    ADD CONSTRAINT users_notes_length
    CHECK (notes IS NULL OR length(notes) <= 4000);
