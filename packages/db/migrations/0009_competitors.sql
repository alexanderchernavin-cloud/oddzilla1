-- Competitors (teams) as first-class entities, scoped per sport.
--
-- Motivation: before this migration, matches stored opponent names inline
-- as home_team/away_team (+ urn) text columns. That blocked admin mapping
-- review from covering team entities and made renames expensive (N match
-- rows to rewrite). It also didn't generalise to future providers where
-- a team identity (logo, short name, home country) is worth its own row.
--
-- Scope-per-sport: a Competitor belongs to one sport. "Rangers" in football
-- ≠ "Rangers" in baseball; Oddin URNs are globally unique so a URN-bearing
-- row is also unique globally, but the slug-uniqueness constraint lives
-- inside a sport to keep slugs short and memorable.
--
-- Denormalised cache preserved: matches.home_team/away_team/home_team_urn/
-- away_team_urn stay put so the catalog API, bet slip, bet history, and
-- settlement continue to read team names without a JOIN. The competitor
-- FKs are additive — existing consumers don't need to know they exist.

CREATE TABLE competitors (
    id            SERIAL       PRIMARY KEY,
    sport_id      INTEGER      NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
    provider      TEXT         NOT NULL DEFAULT 'oddin',
    provider_urn  TEXT,
    slug          TEXT         NOT NULL,
    name          TEXT         NOT NULL,
    abbreviation  TEXT,
    active        BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (sport_id, slug)
);

-- Partial unique index: when a provider URN is present it's the canonical
-- key (Oddin never reuses competitor URNs across sports). When absent
-- (inline-only team from an AMQP odds_change message without a fixture
-- lookup) we fall back to the (sport_id, slug) uniqueness above.
CREATE UNIQUE INDEX competitors_provider_urn_uniq
    ON competitors (provider, provider_urn)
    WHERE provider_urn IS NOT NULL;

CREATE INDEX competitors_sport_idx ON competitors (sport_id);

ALTER TABLE matches
    ADD COLUMN home_competitor_id INTEGER REFERENCES competitors(id),
    ADD COLUMN away_competitor_id INTEGER REFERENCES competitors(id);

CREATE INDEX matches_home_competitor_idx ON matches (home_competitor_id);
CREATE INDEX matches_away_competitor_idx ON matches (away_competitor_id);

-- ─── Backfill ──────────────────────────────────────────────────────────
-- Derive one competitors row per (sport, slugged team name) from existing
-- matches. Skip empty / "TBD" placeholders — those matches keep NULL
-- competitor FKs until the feed supplies real names.
--
-- Slugify matches the Go slugify() in feed-ingester/internal/automap: lower
-- case, collapse non-[a-z0-9] runs to '-', trim leading/trailing '-'.

CREATE OR REPLACE FUNCTION pg_temp.slugify(name text) RETURNS text
    LANGUAGE sql IMMUTABLE AS $$
    SELECT trim(both '-' from
        regexp_replace(lower(coalesce(name, '')), '[^a-z0-9]+', '-', 'g')
    );
$$;

WITH match_sides AS (
    SELECT m.id, s.id AS sport_id,
           m.home_team AS name,
           NULLIF(m.home_team_urn, '') AS urn
      FROM matches m
      JOIN tournaments t ON t.id = m.tournament_id
      JOIN categories  c ON c.id = t.category_id
      JOIN sports      s ON s.id = c.sport_id
     WHERE m.home_team <> '' AND m.home_team <> 'TBD'
    UNION ALL
    SELECT m.id, s.id,
           m.away_team,
           NULLIF(m.away_team_urn, '')
      FROM matches m
      JOIN tournaments t ON t.id = m.tournament_id
      JOIN categories  c ON c.id = t.category_id
      JOIN sports      s ON s.id = c.sport_id
     WHERE m.away_team <> '' AND m.away_team <> 'TBD'
),
slugged AS (
    SELECT sport_id, urn, name, pg_temp.slugify(name) AS slug
      FROM match_sides
     WHERE pg_temp.slugify(name) <> ''
)
INSERT INTO competitors (sport_id, provider, provider_urn, slug, name)
SELECT DISTINCT ON (sport_id, slug)
       sport_id, 'oddin', urn, slug, name
  FROM slugged
 ORDER BY sport_id, slug, (urn IS NULL), urn
ON CONFLICT (sport_id, slug) DO NOTHING;

-- Second pass: link match FKs by (sport_id, slug). Covers both rows we
-- just inserted and any pre-existing rows from a repeat run.
UPDATE matches m
   SET home_competitor_id = c.id
  FROM tournaments t
  JOIN categories  cat ON cat.id = t.category_id
  JOIN competitors c   ON c.sport_id = cat.sport_id
                      AND c.slug     = pg_temp.slugify(m.home_team)
 WHERE m.tournament_id = t.id
   AND m.home_competitor_id IS NULL
   AND m.home_team <> '' AND m.home_team <> 'TBD'
   AND pg_temp.slugify(m.home_team) <> '';

UPDATE matches m
   SET away_competitor_id = c.id
  FROM tournaments t
  JOIN categories  cat ON cat.id = t.category_id
  JOIN competitors c   ON c.sport_id = cat.sport_id
                      AND c.slug     = pg_temp.slugify(m.away_team)
 WHERE m.tournament_id = t.id
   AND m.away_competitor_id IS NULL
   AND m.away_team <> '' AND m.away_team <> 'TBD'
   AND pg_temp.slugify(m.away_team) <> '';
