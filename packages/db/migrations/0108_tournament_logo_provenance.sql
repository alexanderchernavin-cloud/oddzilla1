-- 0108_tournament_logo_provenance
--
-- Records WHERE a tournament's logo came from, so an automatically
-- sourced mark can be told from an operator's upload and audited or
-- reverted in bulk.
--
-- Context: 460 of 1 880 tournaments carry a logo and every one of them
-- comes from Fonbet's own catalogue (`line/logos`), which is fully
-- consumed — that is all Fonbet has. The Oddin esports half has none at
-- all and no first-party source: the Oddin REST token returns 403 and
-- the stack has run on the Bifrost backup feed since 2026-09-03, whose
-- `Tournament` type exposes `sport { icon }` but no tournament icon.
--
-- So the rest has to be sourced from third parties, and that makes
-- provenance load-bearing rather than nice to have. Measured on real
-- names before writing this: naive Wikidata lookup matches the WOMEN'S
-- competition for a men's league often enough to matter (EuroLeague →
-- "EuroLeagueWomen.png", Finland's Liiga → "Naisten Liiga logo.png",
-- because the men's entity frequently carries no logo claim and the
-- search falls through). A wrong crest is worse than a blank one, so
-- every automatic fetch is adjudicated before it lands and every row
-- records what decided it.
--
-- Columns are nullable / defaulted; existing rows keep today's behaviour
-- until something writes to them.

SET LOCAL lock_timeout = '5s';

ALTER TABLE tournaments
  -- 'fonbet'     — from the Fonbet logo catalogue (the existing 460)
  -- 'wikidata'   — sourced automatically and verified
  -- 'liquipedia' — same, from the esports wikis. Kept distinct from
  --                wikidata precisely so it can be revoked on its own:
  --                Liquipedia's marks are largely non-free, and a single
  --                `WHERE logo_source = 'liquipedia'` has to be enough
  --                to undo the lot.
  -- 'manual'     — an operator pasted a URL or uploaded bytes
  ADD COLUMN IF NOT EXISTS logo_source TEXT,
  -- The page/entity the mark came from, kept for attribution and so a
  -- bad batch can be found and reverted by source.
  ADD COLUMN IF NOT EXISTS logo_source_url TEXT,
  -- Bounded retry, same shape as risk_tier_attempts: a tournament with
  -- no logo anywhere must stop being looked up on every sweep.
  ADD COLUMN IF NOT EXISTS logo_attempts SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS logo_checked_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_logo_source_check'
  ) THEN
    ALTER TABLE tournaments
      ADD CONSTRAINT tournaments_logo_source_check
      CHECK (logo_source IS NULL OR logo_source IN ('fonbet', 'wikidata', 'liquipedia', 'manual'));
  END IF;
END
$$;

-- Everything that already has a logo came from Fonbet's catalogue: the
-- feed is the only writer of tournament logos to date, and every stored
-- URL points at their static CDN. Operator uploads stamp a
-- /api/tournaments/<id>/logo URL instead, so they are distinguishable.
UPDATE tournaments
   SET logo_source = CASE
         WHEN logo_url LIKE '/api/tournaments/%' THEN 'manual'
         ELSE 'fonbet'
       END
 WHERE logo_url IS NOT NULL
   AND logo_source IS NULL;

COMMENT ON COLUMN tournaments.logo_source IS
  'Where the logo came from: fonbet (feed catalogue), wikidata (auto-sourced + verified), manual (operator).';
COMMENT ON COLUMN tournaments.logo_source_url IS
  'Origin page/entity of an auto-sourced logo, for attribution and bulk revert.';
COMMENT ON COLUMN tournaments.logo_attempts IS
  'Automatic logo lookups made. Bounds retry on tournaments no source carries.';
