-- 0048_notif_community_highlights_default_on.sql
--
-- Flip pref_community_highlights default to TRUE.
--
-- Migration 0044 set it to FALSE — symmetric with pref_competition_updates,
-- which has a sibling auto-enable on competition join
-- (`ensureCompetitionUpdatesEnabled`). pref_community_highlights has no
-- equivalent — writing an analysis does not enable notifications on its
-- engagement. The result: any user who publishes an analysis is silently
-- not notified when it gets thumbs-up, forever, until they manually
-- visit /account/community.
--
-- This migration:
--   • Changes the column default to TRUE so new users (and rows lazily
--     inserted on first PATCH) get the new behavior.
--   • Does NOT backfill existing rows. Users who already toggled the
--     pref keep their stored value; users who never wrote an analysis
--     and have no row at all read DEFAULT_PREFS in code on each emit,
--     which now also defaults to TRUE.
--
-- Symmetric DB ↔ code lockstep (per 0044 preamble): DEFAULT_PREFS in
-- services/api/src/modules/community/notifications.ts is updated in
-- the same PR.

BEGIN;

ALTER TABLE user_preferences
    ALTER COLUMN pref_community_highlights SET DEFAULT TRUE;

COMMIT;
