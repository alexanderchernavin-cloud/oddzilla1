-- 0010_odds_config_global_unique.sql
--
-- Two problems the unique constraint on (scope, scope_ref_id) did not
-- catch: Postgres treats NULL values as distinct, so multiple
-- scope='global' rows (scope_ref_id IS NULL) accumulated whenever the
-- admin PUT endpoint's lookup silently missed the existing row (fixed
-- in the same changeset — eq(col, NULL) → isNull(col)).
--
-- This migration:
--   1) Deduplicates scope='global' rows, keeping the oldest (lowest id)
--      and resetting it to payback_margin_bp=0. Oddin already delivers
--      margined odds, so the house margin default is zero.
--   2) Adds a partial unique index so NULL scope_ref_id can't collide
--      ever again at the global scope.

BEGIN;

-- Keep a single global row — the one with the lowest id — and set its
-- margin to 0. Update the audit trail so we can see the reset.
UPDATE odds_config
SET payback_margin_bp = 0,
    updated_at = NOW()
WHERE id = (
  SELECT MIN(id) FROM odds_config WHERE scope = 'global'
)
AND scope = 'global';

DELETE FROM odds_config
WHERE scope = 'global'
  AND id <> (SELECT MIN(id) FROM odds_config WHERE scope = 'global');

-- Prevent duplicate globals from reappearing. The existing
-- odds_config_scope unique constraint on (scope, scope_ref_id) does not
-- cover the NULL case.
CREATE UNIQUE INDEX IF NOT EXISTS odds_config_global_unique
  ON odds_config (scope)
  WHERE scope = 'global';

COMMIT;
