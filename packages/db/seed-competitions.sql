-- Seed a demo competition for smoke testing. Idempotent.
--
-- Re-running drops + recreates the demo competition by id; participants
-- and predictions are cleared as a side-effect (ON DELETE CASCADE).
-- The fixed UUID makes the URL stable for QA.

BEGIN;

DELETE FROM competitions WHERE id = 'aaaaaaaa-1111-4111-8111-111111111111'::uuid;

INSERT INTO competitions (
    id, title, description, type, status,
    sport_id, league,
    launch_at, bet_close_at, match_start_at, stop_show_at,
    featured, markets,
    match_count
) VALUES (
    'aaaaaaaa-1111-4111-8111-111111111111',
    'Premier League — Weekend Predictor',
    E'Predict the scores for this weekend''s Premier League fixtures.\n\nExact score: +5 points\nCorrect winner: +3 points\nGoal difference: +2 points',
    'prediction',
    'upcoming',
    NULL,                                          -- multi-sport ok for demo
    'Premier League',
    now() - interval '1 day',                      -- launch in past
    now() + interval '12 hours',                   -- picks close in 12h
    now() + interval '13 hours',                   -- first kickoff
    now() + interval '7 days',                     -- stops showing in 7d
    TRUE,
    ARRAY['1X2', 'correct-score', 'goals'],
    3                                              -- match_count, in sync with the matches inserted below
);

INSERT INTO competition_rules (competition_id, rule_id, value, sort_order) VALUES
    ('aaaaaaaa-1111-4111-8111-111111111111', 'scoring-correct-result', '3', 0),
    ('aaaaaaaa-1111-4111-8111-111111111111', 'scoring-exact-score',    '5', 1),
    ('aaaaaaaa-1111-4111-8111-111111111111', 'scoring-goal-difference','2', 2),
    ('aaaaaaaa-1111-4111-8111-111111111111', 'entry-free',             NULL, 3),
    ('aaaaaaaa-1111-4111-8111-111111111111', 'tiebreaker-earliest',    NULL, 4),
    ('aaaaaaaa-1111-4111-8111-111111111111', 'timing-lock-kickoff',    NULL, 5),
    ('aaaaaaaa-1111-4111-8111-111111111111', 'eligibility-open',       NULL, 6);

INSERT INTO competition_matches (competition_id, team_a, team_b, league, kickoff_at, sort_order) VALUES
    ('aaaaaaaa-1111-4111-8111-111111111111', 'Arsenal',         'Manchester City', 'Premier League', now() + interval '13 hours', 0),
    ('aaaaaaaa-1111-4111-8111-111111111111', 'Liverpool',       'Chelsea',         'Premier League', now() + interval '14 hours', 1),
    ('aaaaaaaa-1111-4111-8111-111111111111', 'Tottenham',       'Manchester United','Premier League', now() + interval '36 hours', 2);

COMMIT;
