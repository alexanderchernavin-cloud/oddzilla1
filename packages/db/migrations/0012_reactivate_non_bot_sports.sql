-- Reverse the 4-sport clamp from migration 0007. Product direction changed:
-- every sport Oddin ships should be usable, except the two bot leagues
-- (eFootball Bots, eBasketball Bots) which remain out of scope. The
-- `unclassified` sport stays inactive too — it's a hidden fallback for
-- fixture lookups that fail.
--
-- The feed-ingester's BLOCKED_ODDIN_SPORT_SLUGS env var
-- (default "efootballbots,ebasketballbots") prevents fresh bot rows from
-- being auto-mapped. This migration lines up the existing DB state with
-- that policy: re-activate everything that was frozen by 0007 and pin the
-- bot slugs to inactive in case a prior run created rows for them.

UPDATE sports
   SET active = TRUE
 WHERE slug NOT IN ('efootballbots', 'ebasketballbots', 'unclassified');

UPDATE tournaments
   SET active = TRUE
 WHERE category_id IN (
   SELECT c.id FROM categories c
   JOIN sports s ON s.id = c.sport_id
   WHERE s.slug NOT IN ('efootballbots', 'ebasketballbots', 'unclassified')
 );

UPDATE sports
   SET active = FALSE
 WHERE slug IN ('efootballbots', 'ebasketballbots');

UPDATE tournaments
   SET active = FALSE
 WHERE category_id IN (
   SELECT c.id FROM categories c
   JOIN sports s ON s.id = c.sport_id
   WHERE s.slug IN ('efootballbots', 'ebasketballbots')
 );
