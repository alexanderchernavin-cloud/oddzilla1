-- Competitor + player profile cache.
--
-- Oddin's odds feed sends outcomes for team/player-specific markets as
-- bare URNs (od:competitor:12528, od:player:10705) with empty `name`
-- fields. Resolving those into human-readable labels requires a REST
-- round-trip to
--   GET /v1/sports/{lang}/competitors/{urn}/profile
-- which returns team name + abbreviation + icon + the full player
-- roster. We cache the result here and refresh on match (re)creation.
--
-- Why two tables instead of one JSONB blob: the players table is what
-- the API joins against when rendering player-prop outcomes, and it
-- carries a back-pointer to competitor_urn so the UI can show "Myrwn
-- (Movistar KOI)" style context when useful.

CREATE TABLE IF NOT EXISTS competitor_profiles (
  urn          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  abbreviation TEXT,
  icon_path    TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS player_profiles (
  urn            TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  full_name      TEXT,
  competitor_urn TEXT,
  sport_urn      TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS player_profiles_competitor_idx
  ON player_profiles (competitor_urn);
