-- 0073_zillapass_no_daily_reset.sql
--
-- ZillaPass — stop daily / weekly task progress from resetting at the
-- start of the next period. Operator requirement: a bettor with 3/5 at
-- end-of-day should still have 3/5 tomorrow, not start fresh.
--
-- Mechanism:
--
--   1. Convert every existing `daily` / `weekly` task to `season`.
--      The writer / reader periodStart helper already returns a fixed
--      '2026-01-01' key for season tasks, so flipping the period flips
--      the storage key from "today's date" to that fixed anchor — every
--      future read + write lands on the same row regardless of calendar
--      day.
--
--   2. Collapse the per-day progress rows we'd otherwise orphan. For
--      every (user_id, task_id) in the affected set, pick the best-ever
--      snapshot — MAX(current_count), with progress_state taken from
--      that same max-count row (matters for set-shaped predicates like
--      `sports_viewed` whose state is a slug array) — and write it
--      under period_start='2026-01-01'. Conservative: we don't sum
--      counters across days or UNION sets across days. A user who
--      placed 3 bets one day and 2 another carries forward 3/5, not
--      5/5; a user who viewed cs2+dota2 one day and lol+valorant the
--      next carries forward whichever pair was largest.
--
--      The OLD model gave them zero credit for either day (neither
--      reached target). The NEW model gives them their best-ever day
--      as a starting point — strictly better, but not retroactively
--      counting attempts they already "spent" against a now-defunct
--      daily reset.
--
--   3. Delete the now-redundant per-day rows for affected tasks.
--      Season-period rows already at '2026-01-01' (e.g. profile-complete)
--      are untouched.
--
--   4. Rewrite task descriptions that previously said "today" or
--      "this week", since the wording is now misleading.
--
--   5. Flip the column default for `period` from 'daily' to 'season'
--      so admin-created tasks land in the no-reset bucket by default.
--      Admins can still explicitly pick 'daily' or 'weekly' via the
--      editor — those periods continue to behave as before per the
--      writer's periodStart logic — but the default surfaces the
--      now-canonical model.
--
-- Idempotent: re-running the migration is a no-op once every task is
-- already 'season' (the affected-task subqueries go empty, descriptions
-- already match, ALTER TABLE DEFAULT is a no-op).
--
-- Step ordering is load-bearing: the INSERT + DELETE both filter by
-- `period <> 'season'`, so they MUST run before the UPDATE that flips
-- period for those tasks (otherwise the affected set vanishes).

BEGIN;

-- 1+2. Collapse per-day progress into one row per (user, task) under
--      the season anchor key. array_agg with ORDER BY gives us the
--      progress_state from whichever row had the highest current_count;
--      MAX / MIN handle the scalar fields.
WITH affected_tasks AS (
    SELECT id FROM zillapass_tasks WHERE period IN ('daily', 'weekly')
),
aggregated AS (
    SELECT
        user_id,
        task_id,
        MAX(current_count) AS current_count,
        MIN(completed_at) AS completed_at,
        MAX(updated_at) AS updated_at,
        (array_agg(progress_state ORDER BY current_count DESC, updated_at DESC))[1]
            AS progress_state
    FROM zillapass_user_progress
    WHERE task_id IN (SELECT id FROM affected_tasks)
    GROUP BY user_id, task_id
)
INSERT INTO zillapass_user_progress
    (user_id, task_id, period_start, current_count, progress_state, completed_at, updated_at)
SELECT
    user_id,
    task_id,
    DATE '2026-01-01',
    current_count,
    progress_state,
    completed_at,
    updated_at
FROM aggregated
ON CONFLICT (user_id, task_id, period_start) DO UPDATE SET
    current_count = GREATEST(
        zillapass_user_progress.current_count,
        EXCLUDED.current_count
    ),
    progress_state = CASE
        WHEN EXCLUDED.current_count >= zillapass_user_progress.current_count
            THEN EXCLUDED.progress_state
        ELSE zillapass_user_progress.progress_state
    END,
    -- Preserve the earliest first-completion. COALESCE handles either
    -- side being NULL; LEAST picks the earlier date when both are set.
    completed_at = LEAST(
        COALESCE(zillapass_user_progress.completed_at, EXCLUDED.completed_at),
        COALESCE(EXCLUDED.completed_at, zillapass_user_progress.completed_at)
    ),
    updated_at = GREATEST(
        zillapass_user_progress.updated_at,
        EXCLUDED.updated_at
    );

-- 3. Drop the redundant dated rows for affected tasks. The season
--    anchor row inserted above is preserved (period_start = '2026-01-01').
DELETE FROM zillapass_user_progress
WHERE task_id IN (
        SELECT id FROM zillapass_tasks WHERE period IN ('daily', 'weekly')
      )
  AND period_start <> DATE '2026-01-01';

-- 4. Convert task period to 'season' for everyone in the affected set.
UPDATE zillapass_tasks
SET period = 'season',
    updated_at = NOW()
WHERE period IN ('daily', 'weekly');

-- 5. Strip the "today" / "this week" wording from seeded task
--    descriptions. Matched by slug so an operator-customised
--    description stays put — only the slugs whose descriptions we
--    shipped via 0061 / 0062 / 0068 / 0069 are touched.
UPDATE zillapass_tasks
SET description = 'Open the page for 5 different sports.'
WHERE slug = 'open-5-sports';

UPDATE zillapass_tasks
SET description = 'Open 5 different matches, each from a different sport.'
WHERE slug = 'open-5-matches-different-sports';

UPDATE zillapass_tasks
SET description = 'Place 5 single bets on prematch markets. Combos and multibets don''t count. USDC and OZ both count toward progress.'
WHERE slug = 'place-5-prematch-bets';

UPDATE zillapass_tasks
SET description = 'Place 5 single bets on live matches. Combos and multibets don''t count. USDC and OZ both count toward progress.'
WHERE slug = 'place-5-live-bets';

UPDATE zillapass_tasks
SET description = 'Switch between the Match, Map, and Top market tabs on a match page 10 times.'
WHERE slug = 'change-market-tab-10';

UPDATE zillapass_tasks
SET description = 'Place 5 bets where every leg is from a Counter-Strike 2 match. Singles and pure-CS2 multibets both count. USDC and OZ both count toward progress.'
WHERE slug = 'place-5-bets-cs2';

UPDATE zillapass_tasks
SET description = 'Place 5 bets where every leg is from a Dota 2 match. Singles and pure-Dota 2 multibets both count. USDC and OZ both count toward progress.'
WHERE slug = 'place-5-bets-dota2';

UPDATE zillapass_tasks
SET description = 'Place 5 bets where every leg is from a League of Legends match. Singles and pure-LoL multibets both count. USDC and OZ both count toward progress.'
WHERE slug = 'place-5-bets-lol';

UPDATE zillapass_tasks
SET description = 'Place 5 combo bets (two or more legs across different matches, multiplied odds). USDC and OZ both count toward progress.'
WHERE slug = 'place-5-combos';

UPDATE zillapass_tasks
SET description = 'Place 5 Tiple bets (multiple legs, partial wins still pay). USDC and OZ both count toward progress.'
WHERE slug = 'place-5-tiples';

UPDATE zillapass_tasks
SET description = 'Place 5 Tippot bets (large multi-leg slip with a Tippot all-wins multiplier). USDC and OZ both count toward progress.'
WHERE slug = 'place-5-tippots';

-- 6. Flip the column default so admin-created tasks default to
--    no-reset. The enum still carries 'daily' + 'weekly' for any
--    operator who explicitly wants reset semantics later.
ALTER TABLE zillapass_tasks
    ALTER COLUMN period SET DEFAULT 'season';

COMMIT;
