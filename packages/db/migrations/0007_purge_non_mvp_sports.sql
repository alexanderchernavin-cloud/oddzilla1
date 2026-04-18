-- One-shot cleanup: remove matches that belong to sports outside the MVP
-- scope (CS2 / Dota2 / LoL / Valorant). The feed-ingester allowlist
-- filters new messages going forward, but the DB still carries ~1500
-- matches from Oddin's integration broker bot feeds (efootballbots,
-- ebasketballbots, dota2-duels, cs2-duels, eCricket, …). Those matches
-- pollute the sport pages and confuse the LIVE indicator because their
-- sports are inactive but their matches remain reachable via direct
-- URLs.
--
-- Safety: only runs while `tickets` and `ticket_selections` are empty.
-- If users have bet on any of these (which shouldn't happen — their
-- sports were always `active=false`), we abort instead of cascading
-- into wallet ledger. Users take precedence over cleanliness.
--
-- Performance note: the previous revision of this migration also did
-- `DELETE FROM odds_history` for the affected markets. On production
-- that meant 22 M rows through a partitioned table inside one
-- transaction, which ran for 60+ minutes without completing. odds_history
-- has no FK to markets, so orphaned rows are harmless — they just sit
-- there unreferenced until the partition rotates out via partman.
-- Keeping the purge focused on the hot tables (matches, markets,
-- market_outcomes, settlements) lets the whole thing finish in seconds
-- rather than hours. The orphans get cleaned up naturally.

DO $$
DECLARE
  ticket_count BIGINT;
  match_count  BIGINT;
BEGIN
  SELECT COUNT(*) INTO ticket_count FROM ticket_selections;
  IF ticket_count > 0 THEN
    RAISE NOTICE 'skipping purge: ticket_selections has % rows', ticket_count;
    RETURN;
  END IF;

  CREATE TEMP TABLE doomed_matches ON COMMIT DROP AS
  SELECT m.id
  FROM matches m
  JOIN tournaments t ON t.id = m.tournament_id
  JOIN categories c  ON c.id = t.category_id
  JOIN sports s      ON s.id = c.sport_id
  WHERE s.slug NOT IN ('cs2', 'dota2', 'lol', 'valorant');

  SELECT COUNT(*) INTO match_count FROM doomed_matches;
  RAISE NOTICE 'purging % out-of-scope matches', match_count;

  -- settlements has no ON DELETE cascade from markets, so clear them
  -- first for the doomed markets.
  DELETE FROM settlements
  WHERE market_id IN (
    SELECT id FROM markets WHERE match_id IN (SELECT id FROM doomed_matches)
  );

  -- matches → markets (CASCADE) → market_outcomes (CASCADE).
  DELETE FROM matches WHERE id IN (SELECT id FROM doomed_matches);

  -- Deactivate non-MVP sports + their tournaments so they vanish from
  -- catalog responses. Do not delete sports — preserve FK history for
  -- any admin audit entries that reference them.
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
END $$;
