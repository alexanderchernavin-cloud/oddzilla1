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
),
-- Collapse rows that share a provider_urn (same team seen under different
-- display names across matches). Pick the most-seen name so the row we
-- keep is the recognisable one. Without this collapse the INSERT would
-- produce multiple (sport_id, slug) candidates sharing the same URN and
-- trip the partial unique index on (provider, provider_urn).
by_urn AS (
    SELECT sport_id, urn, slug, name, cnt
      FROM (
        SELECT sport_id, urn, slug, name, cnt,
               ROW_NUMBER() OVER (
                 PARTITION BY urn
                 ORDER BY cnt DESC, slug
               ) AS rn
          FROM (
            SELECT sport_id, urn, slug, name, COUNT(*) AS cnt
              FROM slugged
             WHERE urn IS NOT NULL
             GROUP BY sport_id, urn, slug, name
          ) grouped
      ) ranked
     WHERE rn = 1
),
-- URN-less rows: one row per (sport_id, slug) with the most-seen name.
by_slug AS (
    SELECT sport_id, slug, name
      FROM (
        SELECT sport_id, slug, name, cnt,
               ROW_NUMBER() OVER (
                 PARTITION BY sport_id, slug
                 ORDER BY cnt DESC, name
               ) AS rn
          FROM (
            SELECT sport_id, slug, name, COUNT(*) AS cnt
              FROM slugged
             WHERE urn IS NULL
             GROUP BY sport_id, slug, name
          ) grouped
      ) ranked
     WHERE rn = 1
),
to_insert AS (
    SELECT sport_id, urn, slug, name FROM by_urn
    UNION ALL
    -- Only insert URN-less rows whose slug isn't already claimed by a
    -- URN-bearing row in the same sport — otherwise we'd hit the
    -- (sport_id, slug) uniqueness.
    SELECT bs.sport_id, NULL::text AS urn, bs.slug, bs.name
      FROM by_slug bs
     WHERE NOT EXISTS (
       SELECT 1 FROM by_urn bu
        WHERE bu.sport_id = bs.sport_id AND bu.slug = bs.slug
     )
)
INSERT INTO competitors (sport_id, provider, provider_urn, slug, name)
SELECT sport_id, 'oddin', urn, slug, name FROM to_insert
ON CONFLICT (sport_id, slug) DO NOTHING;

-- Second pass: link match FKs. Prefer URN (authoritative, survives team
-- renames) and fall back to (sport_id, slug) for rows that never had a
-- URN. Two UPDATEs per side keep the logic readable and the WHERE
-- clauses narrow enough to use indexes.
UPDATE matches m
   SET home_competitor_id = c.id
  FROM competitors c
 WHERE m.home_competitor_id IS NULL
   AND m.home_team_urn IS NOT NULL AND m.home_team_urn <> ''
   AND c.provider = 'oddin'
   AND c.provider_urn = m.home_team_urn;

-- Cross-product FROM (not JOIN ... ON) so that `m` — the UPDATE target —
-- only appears in WHERE. Postgres forbids referencing the UPDATE target
-- inside a JOIN's ON clause in UPDATE ... FROM.
UPDATE matches m
   SET home_competitor_id = c.id
  FROM tournaments t, categories cat, competitors c
 WHERE m.tournament_id    = t.id
   AND cat.id             = t.category_id
   AND c.sport_id         = cat.sport_id
   AND c.slug             = pg_temp.slugify(m.home_team)
   AND m.home_competitor_id IS NULL
   AND m.home_team <> '' AND m.home_team <> 'TBD'
   AND pg_temp.slugify(m.home_team) <> '';

UPDATE matches m
   SET away_competitor_id = c.id
  FROM competitors c
 WHERE m.away_competitor_id IS NULL
   AND m.away_team_urn IS NOT NULL AND m.away_team_urn <> ''
   AND c.provider = 'oddin'
   AND c.provider_urn = m.away_team_urn;

UPDATE matches m
   SET away_competitor_id = c.id
  FROM tournaments t, categories cat, competitors c
 WHERE m.tournament_id    = t.id
   AND cat.id             = t.category_id
   AND c.sport_id         = cat.sport_id
   AND c.slug             = pg_temp.slugify(m.away_team)
   AND m.away_competitor_id IS NULL
   AND m.away_team <> '' AND m.away_team <> 'TBD'
   AND pg_temp.slugify(m.away_team) <> '';
