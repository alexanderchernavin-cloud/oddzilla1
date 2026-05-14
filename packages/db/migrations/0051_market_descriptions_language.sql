-- Multi-language market + outcome description templates.
--
-- Oddin's /v1/descriptions/{lang}/markets endpoint returns the same
-- template catalogue translated into the requested language. Until
-- now feed-ingester fetched only the one language configured via
-- ODDIN_LANG and the API rendered every storefront in that one
-- language. With the i18n pass shipping CS/PT/RU/ES alongside EN, the
-- storefront needs to read the description row that matches the
-- viewer's picked locale.
--
-- This migration:
--   1. Adds `language CHAR(2)` to market_descriptions + outcome_descriptions,
--      defaulting NEW rows to 'en' so the column is non-null.
--   2. Backfills EVERY existing row to 'en' — anything currently in
--      the table came from the single-language fetch and is the EN
--      catalogue.
--   3. Drops the old composite primary keys and rebuilds them with
--      `language` appended so a (provider_market_id, variant, language)
--      tuple — and the outcome-table equivalent — is unique. The
--      feed-ingester's UpsertMarketDescriptions ON CONFLICT clause now
--      keys on that wider tuple, so the same provider_market_id can
--      live once per language.
--
-- The `language` column carries the Oddin lang code as-is (2 letters
-- per their public docs) rather than a BCP-47 tag. Our storefront's
-- locale slugs (en/cs/pt/ru/es) are valid Oddin codes, so the FE can
-- pass its locale directly without a mapping table.

BEGIN;

ALTER TABLE market_descriptions
  ADD COLUMN IF NOT EXISTS language CHAR(2) NOT NULL DEFAULT 'en';

ALTER TABLE outcome_descriptions
  ADD COLUMN IF NOT EXISTS language CHAR(2) NOT NULL DEFAULT 'en';

-- Old PKs are named after the table — drop unconditionally; the
-- IF EXISTS guards a re-run.
ALTER TABLE market_descriptions DROP CONSTRAINT IF EXISTS market_descriptions_pkey;
ALTER TABLE outcome_descriptions DROP CONSTRAINT IF EXISTS outcome_descriptions_pkey;

-- Recreate with `language` appended. Same column order in both, so
-- queries that filter by (provider_market_id, variant) only still
-- use the leading-column prefix of this composite index.
ALTER TABLE market_descriptions
  ADD CONSTRAINT market_descriptions_pkey
  PRIMARY KEY (provider_market_id, variant, language);

ALTER TABLE outcome_descriptions
  ADD CONSTRAINT outcome_descriptions_pkey
  PRIMARY KEY (provider_market_id, variant, outcome_id, language);

COMMIT;
