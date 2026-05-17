-- 0064_zillapass_stages.sql
--
-- ZillaPass — per-user stage progression. Tasks are now organised in
-- ordered SETS; a user only sees the set they're currently on, and
-- advances to the next set ONE UTC DAY AFTER they complete the
-- current one. Different users can be on different stages.
--
-- Lifecycle:
--
--   - New user defaults to current_set_number = 1, last_set_completed_date NULL.
--   - On every task-completion nudge, the writer checks "is the user's
--     current set fully done today?" — if yes, stamps
--     last_set_completed_date = today (UTC). Idempotent: subsequent
--     stamps are no-ops while the date holds.
--   - On every /zillapass/me read, if last_set_completed_date IS NOT NULL
--     AND < today (UTC), the reader advances: current_set_number += 1
--     and last_set_completed_date back to NULL.
--   - A user past the max seeded set_number sees no active tasks.
--     Admin seeds a new set with set_number = N and those users pick
--     it up on the next read.
--
-- Two table changes:
--
--   1. zillapass_tasks gains `set_number` (≥ 1). Existing seeded tasks
--      backfilled by slug: day-1 set → 1, day-2 set → 2.
--
--   2. zillapass_user_state gains `current_set_number` (≥ 1, default 1)
--      and `last_set_completed_date` (nullable DATE). Existing rows
--      backfill to (1, NULL) so a pre-stage user lands at the start.

BEGIN;

-- ─── tasks: set_number ───────────────────────────────────────────────────────

ALTER TABLE zillapass_tasks
    ADD COLUMN set_number INTEGER NOT NULL DEFAULT 1
    CHECK (set_number >= 1);

-- Backfill the two seeded sets. UPDATE is idempotent.
UPDATE zillapass_tasks
SET set_number = 1
WHERE slug IN (
    'profile-complete',
    'open-5-sports',
    'open-5-matches-different-sports'
);

UPDATE zillapass_tasks
SET set_number = 2
WHERE slug IN (
    'place-5-prematch-bets',
    'place-5-live-bets',
    'change-market-tab-10'
);

-- Hot query: list this set's active tasks ordered for display. Drops
-- the prior `(active, sort_order, id)` index since the new one is a
-- strict superset for both /zillapass/me and the admin list.
DROP INDEX IF EXISTS zillapass_tasks_active_sort_idx;
CREATE INDEX zillapass_tasks_set_active_sort_idx
    ON zillapass_tasks (set_number, active, sort_order, id);

-- ─── user_state: current_set_number + last_set_completed_date ───────────────

ALTER TABLE zillapass_user_state
    ADD COLUMN current_set_number INTEGER NOT NULL DEFAULT 1
    CHECK (current_set_number >= 1);

ALTER TABLE zillapass_user_state
    ADD COLUMN last_set_completed_date DATE;

COMMIT;
