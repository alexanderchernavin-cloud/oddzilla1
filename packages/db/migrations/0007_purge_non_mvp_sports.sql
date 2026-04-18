-- Cleanup: mark non-MVP sports + their tournaments as inactive so they
-- vanish from every catalog response.
--
-- History: earlier revisions of this file DELETEd matches + markets +
-- market_outcomes + settlements + odds_history for out-of-scope sports.
-- Two production attempts took > 30 minutes each without committing,
-- because the cascade chain is large (1 500 matches → 180 k markets →
-- 430 k outcomes → 340 k settlements) and competes for row locks with
-- the live feed. We also tried batching and skipping odds_history, but
-- the hot-table cascades alone still timed out.
--
-- Pragmatic alternative: leave the rows in place and just flip
-- `active=false`. The feed-ingester sport allowlist prevents any
-- NEW bot-sport rows from being created, and all catalog endpoints
-- filter on `sports.active = true`, so inactive sports + their
-- tournaments/matches become invisible to the frontend without any
-- expensive DELETE cascade. Orphaned rows cost a few megabytes of
-- disk and zero correctness.

UPDATE sports
   SET active = false
 WHERE slug NOT IN ('cs2', 'dota2', 'lol', 'valorant');

UPDATE tournaments
   SET active = false
 WHERE category_id IN (
   SELECT c.id FROM categories c
   JOIN sports s ON s.id = c.sport_id
   WHERE s.slug NOT IN ('cs2', 'dota2', 'lol', 'valorant')
 );

UPDATE sports
   SET active = true
 WHERE slug IN ('cs2', 'dota2', 'lol', 'valorant');
