-- SlotZilla demo games: three recorded FIBA Women's World Cup fixtures that
-- replay on a permanent loop, so the section always has something playable
-- whether or not real basketball is live.
--
-- WHY A RECORDING RATHER THAN A SIMULATION. The whole game is a claim about
-- a real play-by-play feed: the reels ARE the match, and the measured symbol
-- distribution (docs/SLOTZILLA.md) comes from real games. A synthetic
-- generator would demo a different product from the one that ships, and its
-- distribution would be whatever we made up. These are real Sportradar
-- timelines from the 2026 tournament, replayed on a virtual clock.
--
-- WHY THE DEMO IS OZ-ONLY, ENFORCED IN CODE. A loop is perfectly
-- predictable: after one cycle, anyone who watched knows every future
-- window's symbols exactly, so a real-money spin on a demo game is a
-- guaranteed-profit exploit rather than a bet. The gate lives in
-- services/api/src/lib/slotzilla/service.ts and refuses any non-OZ currency
-- on a demo game regardless of slotzilla_config.currencies — deliberately
-- NOT a config flag, so no operator setting can ever open it. This column
-- is what that gate reads, which is why it is on the game row rather than
-- inferred from the tournament.
--
-- The recordings themselves are NOT seeded here. sr_live_events is keyed by
-- Sportradar's own event id and the engine loads a game's events by
-- sr_match_id, so pointing a demo game at the archived sr_match_id is
-- enough: services/slotzilla fetches that one timeline once, stores it the
-- same way the calibration corpus does, and replays from Postgres forever
-- after. Seeding ~1400 event rows as SQL would duplicate the corpus path
-- and go stale against the parser.

SET LOCAL lock_timeout = '5s';

-- ── The demo flag + loop anchor ─────────────────────────────────────────
ALTER TABLE slotzilla_games
  ADD COLUMN IF NOT EXISTS is_demo    boolean NOT NULL DEFAULT false,
  -- The instant cycle 0 of this game's loop began. Each demo game gets a
  -- different anchor so the three are at different points in their match
  -- at any moment — three fixtures all tipping off together would look
  -- like what it is. Fixed rather than "now" so a re-run of this file, or
  -- a restore from a dump, resumes the same phase instead of jumping.
  ADD COLUMN IF NOT EXISTS demo_epoch timestamptz;

-- Cycle length is deliberately NOT stored. The driver derives it from the
-- recording it loaded (max event second + a cooldown), so a column can
-- never disagree with the events it is supposed to describe.

COMMENT ON COLUMN slotzilla_games.is_demo IS
  'Looping recorded fixture. Hard-gated to OZ at placement; never real money.';

-- ── Catalog rows for the three fixtures ─────────────────────────────────
-- Under the real Basketball sport, in a category of their own. They carry
-- NO markets, which is what keeps them out of the betting product
-- entirely: every list, the sidebar tournament tree, live counts and
-- search all gate on hasActiveMarket (services/api/src/lib/catalog-
-- predicates.ts), so a market-less match is invisible to all of them.
-- SlotZilla reads slotzilla_games directly and is the only surface that
-- sees these.
--
-- `demo:` URNs put them outside both ingesters' catalog-wide flushes
-- (invariant 10 scopes those to 'od:match:%' / 'fb:match:%'), the same
-- reason custom events use 'cu:'. Nothing else writes these rows.
DO $$
DECLARE
  v_sport_id      integer;
  v_category_id   integer;
  v_tournament_id integer;
  v_match_id      bigint;
  r               record;
BEGIN
  SELECT id INTO v_sport_id FROM sports WHERE slug = 'basketball';
  IF v_sport_id IS NULL THEN
    RAISE NOTICE 'no basketball sport row; skipping SlotZilla demo seed';
    RETURN;
  END IF;

  INSERT INTO categories (sport_id, provider_urn, slug, name, is_dummy, active)
  VALUES (v_sport_id, 'demo:category:slotzilla', 'slotzilla-demo', 'SlotZilla Demo', false, true)
  ON CONFLICT (sport_id, slug) DO NOTHING;
  SELECT id INTO v_category_id
    FROM categories WHERE sport_id = v_sport_id AND slug = 'slotzilla-demo';

  -- Kept out of the match lists as a second layer, so that if one of these
  -- fixtures ever DOES acquire a market by accident it still cannot reach
  -- the storefront's betting surfaces (migration 0102).
  UPDATE categories SET hidden_from_lists = true WHERE id = v_category_id;

  INSERT INTO tournaments (category_id, provider_urn, slug, name, active)
  VALUES (v_category_id, 'demo:tournament:fiba-wwc-2026', 'fiba-wwc-2026-demo',
          'FIBA Women''s World Cup 2026 (demo)', true)
  ON CONFLICT (provider_urn) DO NOTHING;
  SELECT id INTO v_tournament_id
    FROM tournaments WHERE provider_urn = 'demo:tournament:fiba-wwc-2026';

  -- The three recordings. Sportradar match ids are real and the games are
  -- finished, so each timeline is fixed and complete. Picked for variety of
  -- shape rather than for scoreline: a two-point knockout finish, a
  -- three-point knockout finish, and a blowout with the densest event feed
  -- of the tournament (measured 2026-09-10: 230 / 191 / 258 slot-relevant
  -- events across 2400 seconds each).
  FOR r IN
    SELECT * FROM (VALUES
      ('demo:match:fiba-1', 71036316::bigint, 'Italy',       'Australia', 0),
      ('demo:match:fiba-2', 71036334::bigint, 'Puerto Rico', 'China',     840),
      ('demo:match:fiba-3', 71036308::bigint, 'USA',         'Czechia',   1680)
    ) AS t(urn, sr_match_id, home, away, stagger_seconds)
  LOOP
    INSERT INTO matches (tournament_id, provider_urn, home_team, away_team, scheduled_at, status)
    VALUES (v_tournament_id, r.urn, r.home, r.away, now(), 'live')
    ON CONFLICT (provider_urn) DO NOTHING;
    SELECT id INTO v_match_id FROM matches WHERE provider_urn = r.urn;

    -- The anchor is a fixed past instant minus the game's stagger, so the
    -- three sit ~14 minutes apart in their cycles from the first tick.
    INSERT INTO slotzilla_games (match_id, sr_match_id, status, is_demo, demo_epoch)
    VALUES (v_match_id, r.sr_match_id, 'live', true,
            TIMESTAMPTZ '2026-09-10 00:00:00+00' - make_interval(secs => r.stagger_seconds))
    ON CONFLICT (match_id) DO UPDATE
      SET is_demo    = true,
          demo_epoch = COALESCE(slotzilla_games.demo_epoch, EXCLUDED.demo_epoch);
  END LOOP;
END $$;
