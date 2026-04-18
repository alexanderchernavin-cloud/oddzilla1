-- Merge auto-created duplicate sports into their seeded counterparts.
--
-- Root cause: the seed in packages/db/src/seed.ts used synthetic URNs like
-- `od:sport:cs2`, but Oddin's AMQP feed actually sends `od:sport:3` (and
-- `1` for LoL, `2` for Dota 2, `13` for Valorant). resolveSport didn't
-- find the seeded row by URN, so it created fresh `s-1`/`s-2`/`s-3`/`s-13`
-- rows and drained all real matches into those — leaving the seeded CS2
-- / Dota 2 / LoL / Valorant sports empty.
--
-- This migration:
--   1. Reparents each s-N's categories into the matching seeded sport
--      (handling the one collision where cs2 already has an auto
--      category from its old fallback role).
--   2. Drops the s-N sport rows.
--   3. Updates seeded sports' provider_urn to the real Oddin values so
--      future feed messages land in the right place straight away.

BEGIN;

-- ── Counter-Strike 2 (cs2) ←— s-3 ───────────────────────────────────
-- cs2 already has an `auto` category from when it was the fallback sport
-- (this was replaced by `unclassified` in migration 0004). Move s-3's
-- tournaments into that same auto category, then drop s-3's now-empty
-- category and sport rows.
WITH
  s3 AS (SELECT id FROM sports WHERE slug = 's-3'),
  s3_auto AS (SELECT id FROM categories WHERE sport_id = (SELECT id FROM s3) AND slug = 'auto'),
  cs2_auto AS (
    SELECT id FROM categories
    WHERE sport_id = (SELECT id FROM sports WHERE slug = 'cs2') AND slug = 'auto'
  )
UPDATE tournaments
SET category_id = (SELECT id FROM cs2_auto)
WHERE category_id = (SELECT id FROM s3_auto);
DELETE FROM categories WHERE sport_id = (SELECT id FROM sports WHERE slug = 's-3');
DELETE FROM sports WHERE slug = 's-3';

-- ── Dota 2 (dota2) ←— s-2 ───────────────────────────────────────────
-- dota2 has no auto category, so reparent s-2's category directly.
UPDATE categories
SET sport_id = (SELECT id FROM sports WHERE slug = 'dota2')
WHERE sport_id = (SELECT id FROM sports WHERE slug = 's-2');
DELETE FROM sports WHERE slug = 's-2';

-- ── League of Legends (lol) ←— s-1 ───────────────────────────────────
UPDATE categories
SET sport_id = (SELECT id FROM sports WHERE slug = 'lol')
WHERE sport_id = (SELECT id FROM sports WHERE slug = 's-1');
DELETE FROM sports WHERE slug = 's-1';

-- ── Valorant (valorant) ←— s-13 ─────────────────────────────────────
UPDATE categories
SET sport_id = (SELECT id FROM sports WHERE slug = 'valorant')
WHERE sport_id = (SELECT id FROM sports WHERE slug = 's-13');
DELETE FROM sports WHERE slug = 's-13';

-- ── Align seeded URNs with what Oddin actually sends ────────────────
-- Without this step, the next match for one of these sports would
-- re-create the s-N duplicate because resolveSport does URN-based lookup.
UPDATE sports SET provider_urn = 'od:sport:3'  WHERE slug = 'cs2';
UPDATE sports SET provider_urn = 'od:sport:2'  WHERE slug = 'dota2';
UPDATE sports SET provider_urn = 'od:sport:1'  WHERE slug = 'lol';
UPDATE sports SET provider_urn = 'od:sport:13' WHERE slug = 'valorant';

COMMIT;
