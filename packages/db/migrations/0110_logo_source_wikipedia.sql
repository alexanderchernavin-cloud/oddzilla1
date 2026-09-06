-- 0110_logo_source_wikipedia
--
-- Adds 'wikipedia' to the tournaments.logo_source allowlist.
--
-- Why a fourth source: Wikidata carries a logo for only about a fifth of
-- the traditional-sport leagues, and not because our matching is weak.
-- Measured end to end on 30 real leagues, ZillaAGI named every one
-- correctly and the adjudicator rejected nothing that was right — the
-- entities simply have no logo claim:
--
--   Q216022  no logo  Belgian Pro League
--   Q175762  no logo  Handball-Bundesliga
--   Q456107  no logo  Liiga
--   Q606832  no logo  Chilean Primera Division
--
-- These marks are trademarked, so they cannot be hosted on Wikimedia
-- Commons, which is what Wikidata's P154 points at. They exist on
-- Wikipedia itself as NON-FREE files used under fair use.
--
-- So this source is materially different from the others and is recorded
-- separately for exactly that reason. `WHERE logo_source = 'wikipedia'`
-- has to be enough to revert the entire set if the position on re-hosting
-- non-free marks ever changes — the same reasoning that gave Liquipedia
-- its own value in 0108, and the runbook in docs/OPERATIONS.md carries
-- the statement for both.

SET LOCAL lock_timeout = '5s';

ALTER TABLE tournaments
  DROP CONSTRAINT IF EXISTS tournaments_logo_source_check;

ALTER TABLE tournaments
  ADD CONSTRAINT tournaments_logo_source_check
  CHECK (
    logo_source IS NULL
    OR logo_source IN ('fonbet', 'wikidata', 'liquipedia', 'wikipedia', 'manual')
  );

COMMENT ON COLUMN tournaments.logo_source IS
  'Where the logo came from: fonbet (feed catalogue), wikidata (free-licensed, auto-sourced), liquipedia / wikipedia (auto-sourced, largely NON-FREE marks — revertible as a set), manual (operator).';
