-- One-shot cleanup: remove matches that belong to sports outside the MVP
-- scope (CS2 / Dota2 / LoL / Valorant). The feed-ingester allowlist
-- filters new messages going forward, but the DB still carries ~900
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

  -- Collect the match ids to delete (any sport other than the 4 MVP
  -- slugs). Excludes `unclassified` too — its matches are reachable
  -- via the fallback tournament, but per the allowlist design they
  -- shouldn't exist and will stop being created after this change.
  CREATE TEMP TABLE doomed_matches ON COMMIT DROP AS
  SELECT m.id
  FROM matches m
  JOIN tournaments t ON t.id = m.tournament_id
  JOIN categories c  ON c.id = t.category_id
  JOIN sports s      ON s.id = c.sport_id
  WHERE s.slug NOT IN ('cs2', 'dota2', 'lol', 'valorant');

  SELECT COUNT(*) INTO match_count FROM doomed_matches;
  RAISE NOTICE 'purging % out-of-scope matches', match_count;

  -- settlements and odds_history don't cascade from markets, so clear
  -- them first. odds_history is partitioned; DELETE walks the parent.
  DELETE FROM settlements
  WHERE market_id IN (
    SELECT id FROM markets WHERE match_id IN (SELECT id FROM doomed_matches)
  );
  DELETE FROM odds_history
  WHERE market_id IN (
    SELECT id FROM markets WHERE match_id IN (SELECT id FROM doomed_matches)
  );

  -- matches → markets (cascade) → market_outcomes (cascade).
  DELETE FROM matches WHERE id IN (SELECT id FROM doomed_matches);

  -- Drop tournaments that no longer have any matches. Prevents empty
  -- tournament shells from lingering on the admin mapping page.
  DELETE FROM tournaments
  WHERE id NOT IN (SELECT DISTINCT tournament_id FROM matches);

  -- Drop categories that no longer have any tournaments, except the
  -- per-sport dummy categories that seeds/autompap depends on.
  DELETE FROM categories
  WHERE is_dummy = false
    AND id NOT IN (SELECT DISTINCT category_id FROM tournaments);

  -- Deactivate non-MVP sports so they never appear in catalog
  -- responses again. Do not delete the rows — keeping them around
  -- keeps foreign-key history intact for audit-log entries that may
  -- reference them.
  UPDATE sports
     SET active = false
   WHERE slug NOT IN ('cs2', 'dota2', 'lol', 'valorant');

  -- Re-activate the 4 MVP sports (idempotent; no harm if already true).
  UPDATE sports
     SET active = true
   WHERE slug IN ('cs2', 'dota2', 'lol', 'valorant');
END $$;
