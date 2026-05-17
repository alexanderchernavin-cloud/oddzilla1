-- 0061_zillapass_set_1.sql
--
-- ZillaPass — first task set + set-shaped progress support.
--
-- Two changes:
--
-- 1. Adds `progress_state JSONB` to zillapass_user_progress.
--    Some predicates need to track a *set* of distinct items (e.g.
--    "open 5 different sports today" must dedupe repeat visits to
--    the same sport). The writer maintains the set in this column;
--    `current_count` mirrors its size. Predicates that only need a
--    counter (e.g. "place 5 bets") leave it `{}`.
--
-- 2. Seeds the first day-set of tasks (idempotent via ON CONFLICT
--    DO NOTHING on slug). Admin can edit titles / descriptions /
--    target counts via /admin/zillapass; rotating them out is a
--    `active = false` toggle, not a delete (delete cascades user
--    progress and the history is lost).
--
--    Predicate keys used:
--
--      profile_complete           — completes when the user has both
--                                   `nickname IS NOT NULL` AND
--                                   `avatar_template_id IS NOT NULL`.
--                                   Period=season so a long-standing
--                                   user who already set both sees
--                                   the row as permanently done; new
--                                   users see it light up the first
--                                   time they save both fields.
--
--      sports_viewed              — daily. progress_state = { sports: [...] }.
--                                   Writer adds the sport slug on
--                                   every /sport/:slug page mount
--                                   for a signed-in user; count is
--                                   the size of the set.
--
--      matches_viewed_diff_sports — daily. progress_state =
--                                   { sports: [...], matches: [...] }.
--                                   Writer adds the (matchId, sportSlug)
--                                   pair on every /match/:id page mount;
--                                   count is the distinct-sport size
--                                   (target = 5 means 5 different
--                                   sports). Re-opening the same
--                                   match is a no-op.

BEGIN;

ALTER TABLE zillapass_user_progress
    ADD COLUMN progress_state JSONB NOT NULL DEFAULT '{}'::jsonb;

INSERT INTO zillapass_tasks
    (slug, title, description, target_count, predicate_key, period, sort_order, active)
VALUES
    ('profile-complete',
     'Complete your profile',
     'Pick a nickname and an avatar in your community profile to make your account yours.',
     1,
     'profile_complete',
     'season',
     10,
     true),
    ('open-5-sports',
     'Browse 5 sports',
     'Open the page for 5 different sports today.',
     5,
     'sports_viewed',
     'daily',
     20,
     true),
    ('open-5-matches-different-sports',
     'View 5 matches from 5 sports',
     'Open 5 different matches today, each from a different sport.',
     5,
     'matches_viewed_diff_sports',
     'daily',
     30,
     true)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
