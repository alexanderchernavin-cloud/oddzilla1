-- Fonbet market types get their own provider_market_id.
--
-- Until now a Fonbet market's id was `1_000_000 + catalogue table`, and
-- Fonbet reuses one table across every sub-event: "Match result",
-- "2nd half: Match result" and "Corners: Match result" were all 1000120,
-- told apart only by the `variant` specifier. Measured on production
-- 2026-09-08: 1 886 distinct (table, sub-event) pairs sharing 30 ids, a
-- 63:1 collision. Every reader that keyed off the integer alone got the
-- wrong market -- the ZillaBoost banner quoted the 2nd half under two team
-- names, isTeamShapedMarket matched nothing on a football team,
-- fe_market_display_order needed a `variant` column bolted on (0109), and
-- bet-assist had to invent its own composite key.
--
-- So each (table, sub-event, double-chance) triple becomes its own market
-- type with its own id, allocated from a registry.
--
-- WHY A REGISTRY AND NOT ARITHMETIC. The components do not fit. Fonbet's
-- sub-event kinds are 6-digit numbers that chain two deep (a half's
-- corners is 400100/10100201) and provider_market_id is int4, so there is
-- no encoding of (table, kind chain) that is both injective and derivable.
-- The accepted trade-off is that the id becomes OPAQUE: a reader can no
-- longer recover the Fonbet table from it, and ids are assigned per
-- environment, so a denylist row exported from production means nothing in
-- development. The registry keeps (table_num, variant, double_chance) on
-- every row precisely so that pairing can always be re-resolved.
--
-- WHY THE PER-PLAYER SUFFIX IS STRIPPED. A per-player variant carries the
-- player on the variant string (`fb:100201:12345`). That is a PARAMETER,
-- not a market type: 1 202 of the 1 264 distinct live variants carry one,
-- and folding it in would give every player their own type and grow this
-- table without bound. Those markets share a type and stay distinct rows
-- because `variant` is part of specifiers_hash, so
-- (match_id, provider_market_id, specifiers_hash) is still unique.
--
-- WHY NOW IS THE CHEAP MOMENT. Measured immediately before writing this:
-- 0 open tickets on any Fonbet market, and 0 Fonbet rows in
-- riskzilla_market_factors, fe_market_display_order or
-- insight_widget_rules. So nothing an operator configured and no bettor's
-- open ticket is re-keyed by this.

SET LOCAL lock_timeout = '5s';

-- ── the feed must be OFF while this runs ────────────────────────────
--
-- Rehearsed against production with the feed live and it DEADLOCKED: the
-- re-key touches every Fonbet market row while fonbet-ingester is
-- upserting the same rows every 5 s, and the two take their row locks in
-- opposite orders. Same shape as the recovery-flush DELETE that deadlocks
-- against feed-ingester (docs note on migration 0023).
--
-- Batching would not fix it -- each batch races the same writer -- so the
-- migration requires the operator to switch the Fonbet feed off first
-- (the runtime switch from migration 0099; it suspends every Fonbet market
-- and stops polling within 2 s). This raises instead of deadlocking so a
-- deploy that skipped that step fails in a way that says what to do,
-- rather than aborting on a lock detail from deep inside Postgres.
--
-- Runbook: PUT /admin/feed/fonbet {enabled:false} (or the Fonbet feed card
-- on /admin/feed) -> make deploy -> switch it back on. The offer comes
-- back on the next cycle; nothing is lost, because the ingester re-upserts
-- whatever Fonbet still quotes.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM feed_control WHERE fonbet_applied_enabled IS TRUE
  ) THEN
    RAISE EXCEPTION
      'fonbet-ingester is still live; switch the Fonbet feed OFF before this migration (see the header)';
  END IF;
END $$;

-- ── the registry ────────────────────────────────────────────────────
--
-- Ids start at 3 000 000, clear of every existing namespace: Oddin's small
-- integers, the legacy Fonbet 1 000 000 / 1 900 000 bands (which historical
-- rows keep) and custom markets at 2 000 000. Readers testing
-- `>= FONBET_PMID_BASE` for "Fonbet or custom" keep working unchanged.
CREATE SEQUENCE IF NOT EXISTS provider_market_type_id_seq
  AS integer START WITH 3000000 MINVALUE 3000000;

CREATE TABLE IF NOT EXISTS provider_market_types (
  provider_market_id integer PRIMARY KEY
    DEFAULT nextval('provider_market_type_id_seq'),
  -- Which feed this type came from. The registry is deliberately NOT
  -- Fonbet-only: the point of allocating our own ids is that a second
  -- provider's "1X2" can be recognised as the same market as the first
  -- one's, and that needs every provider's types in one table. Fonbet is
  -- simply the provider whose ids forced the issue first.
  provider text NOT NULL DEFAULT 'fonbet',
  -- The provider's own market-type number: Fonbet's catalogue table
  -- (NOT 1 000 000 + it), Oddin's market id.
  table_num integer NOT NULL,
  -- Sub-event kind chain with any per-player suffix stripped: "" for the
  -- main event, "100201" for the 1st half, "400100/10100201" for a half's
  -- corners.
  variant text NOT NULL DEFAULT '',
  -- The 1X / X2 / 12 cells the ingester splits off a match-winner table.
  -- A distinct TYPE of the same table, which is why it is a flag here
  -- rather than a second table number.
  double_chance boolean NOT NULL DEFAULT false,
  -- The readable key every consumer should prefer to the opaque id:
  -- "fb:120", "fb:120@100201", "fb:120#dc", "od:1". Generated, so it can
  -- never drift from the columns it describes, and matching
  -- packages/types/src/market-kind.ts byte for byte.
  market_kind text NOT NULL GENERATED ALWAYS AS (
    CASE provider WHEN 'fonbet' THEN 'fb:' ELSE 'od:' END || table_num::text
      || CASE WHEN variant = '' THEN '' ELSE '@' || variant END
      || CASE WHEN double_chance THEN '#dc' ELSE '' END
  ) STORED,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_market_types_key
    UNIQUE (provider, table_num, variant, double_chance)
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_market_types_kind_idx
  ON provider_market_types (market_kind);

-- ── seed it from what is already stored ─────────────────────────────
--
-- Every (table, sub-event) pair the catalogue has produced so far, whether
-- or not the market is still open: historical rows are re-keyed too, so
-- that ticket history and settlements keep resolving to the same market
-- row (settlements.market_id is a FK to markets.id, not the provider id,
-- so nothing there needs rewriting -- but the ingester must not later
-- allocate a second id for a pair it already wrote).
--
-- The legacy id decode mirrors mapper.MarketTypeOf: >= 1 900 000 is the
-- double-chance band, otherwise 1 000 000 + table. Custom markets
-- (2 000 000) are excluded -- they are not Fonbet.
-- Seeded from the UNION of every table that references a Fonbet
-- provider_market_id, not just `markets`. The description tables carry a
-- row for every catalogue type the ingester has ever seen, including types
-- with no market currently open — seeding from `markets` alone left 1 156
-- market_descriptions and 16 772 outcome_descriptions rows with no id to
-- move to, measured in rehearsal.
INSERT INTO provider_market_types (provider, table_num, variant, double_chance)
SELECT DISTINCT
  'fonbet',
  CASE WHEN pmid >= 1900000 THEN pmid - 1900000 ELSE pmid - 1000000 END,
  regexp_replace(regexp_replace(coalesce(variant, ''), '^fb:', ''), ':[0-9]+$', ''),
  pmid >= 1900000
FROM (
  SELECT m.provider_market_id AS pmid, m.specifiers_json->>'variant' AS variant
    FROM markets m
   WHERE m.provider_market_id >= 1000000 AND m.provider_market_id < 2000000
  UNION
  SELECT d.provider_market_id, d.variant
    FROM market_descriptions d
   WHERE d.provider_market_id >= 1000000 AND d.provider_market_id < 2000000
  UNION
  SELECT d.provider_market_id, d.variant
    FROM outcome_descriptions d
   WHERE d.provider_market_id >= 1000000 AND d.provider_market_id < 2000000
) src
ON CONFLICT (provider, table_num, variant, double_chance) DO NOTHING;

-- ── re-key the markets ──────────────────────────────────────────────
--
-- One statement, joined through the registry on the same decode. Done
-- before the descriptions so a failure here leaves both untouched.
UPDATE markets m
   SET provider_market_id = t.provider_market_id
  FROM provider_market_types t
 WHERE t.provider = 'fonbet'
   AND m.provider_market_id >= 1000000
   AND m.provider_market_id < 2000000
   AND t.table_num = CASE WHEN m.provider_market_id >= 1900000
                          THEN m.provider_market_id - 1900000
                          ELSE m.provider_market_id - 1000000 END
   AND t.double_chance = (m.provider_market_id >= 1900000)
   AND t.variant = regexp_replace(
         regexp_replace(coalesce(m.specifiers_json->>'variant', ''), '^fb:', ''),
         ':[0-9]+$', ''
       );

-- ── re-key the description rows ─────────────────────────────────────
--
-- market_descriptions / outcome_descriptions are keyed
-- (provider_market_id, variant, language). The new id already encodes the
-- sub-event, so `variant` becomes redundant there -- left in place rather
-- than dropped, because a per-player market keeps its full variant string
-- (player id and all) on the market row, and those rows still need a
-- description each.
UPDATE market_descriptions d
   SET provider_market_id = t.provider_market_id
  FROM provider_market_types t
 WHERE t.provider = 'fonbet'
   AND d.provider_market_id >= 1000000
   AND d.provider_market_id < 2000000
   AND t.table_num = CASE WHEN d.provider_market_id >= 1900000
                          THEN d.provider_market_id - 1900000
                          ELSE d.provider_market_id - 1000000 END
   AND t.double_chance = (d.provider_market_id >= 1900000)
   AND t.variant = regexp_replace(
         regexp_replace(coalesce(d.variant, ''), '^fb:', ''), ':[0-9]+$', ''
       );

UPDATE outcome_descriptions d
   SET provider_market_id = t.provider_market_id
  FROM provider_market_types t
 WHERE t.provider = 'fonbet'
   AND d.provider_market_id >= 1000000
   AND d.provider_market_id < 2000000
   AND t.table_num = CASE WHEN d.provider_market_id >= 1900000
                          THEN d.provider_market_id - 1900000
                          ELSE d.provider_market_id - 1000000 END
   AND t.double_chance = (d.provider_market_id >= 1900000)
   AND t.variant = regexp_replace(
         regexp_replace(coalesce(d.variant, ''), '^fb:', ''), ':[0-9]+$', ''
       );

-- ── the denylist moves to table numbers ─────────────────────────────
--
-- FORCED, not tidying: a denylist rule means "no grader can settle this
-- Fonbet TABLE", and it has always applied to every sub-event of it. With
-- one id per sub-event a single provider_market_id can no longer say that,
-- so the rule keys on the table number the operator is actually naming.
ALTER TABLE fonbet_market_denylist
  ADD COLUMN IF NOT EXISTS table_num integer;

UPDATE fonbet_market_denylist
   SET table_num = CASE WHEN provider_market_id >= 1900000
                        THEN provider_market_id - 1900000
                        ELSE provider_market_id - 1000000 END
 WHERE kind = 'table'
   AND provider_market_id IS NOT NULL
   AND table_num IS NULL;

DROP INDEX IF EXISTS fonbet_market_denylist_table_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS fonbet_market_denylist_table_uniq
  ON fonbet_market_denylist (table_num)
  WHERE kind = 'table';

ALTER TABLE fonbet_market_denylist
  DROP CONSTRAINT IF EXISTS fonbet_market_denylist_kind_shape;
ALTER TABLE fonbet_market_denylist
  ADD CONSTRAINT fonbet_market_denylist_kind_shape CHECK (
    (kind = 'table' AND table_num IS NOT NULL AND label_prefix IS NULL)
    OR (kind = 'label_prefix' AND label_prefix IS NOT NULL AND table_num IS NULL)
  );

ALTER TABLE fonbet_market_denylist
  DROP COLUMN IF EXISTS provider_market_id;
