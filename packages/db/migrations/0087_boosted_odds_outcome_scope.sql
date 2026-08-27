-- 0087_boosted_odds_outcome_scope.sql
--
-- Adds the 'outcome' value to boosted_odds_scope so a ZillaBoost rule
-- can be pinned to a single SELECTION (one market_outcomes cell) rather
-- than a whole market. The columns, CHECK, and unique index that make
-- the new scope usable land in 0088.
--
-- Deliberately its own migration file: Postgres allows ALTER TYPE ...
-- ADD VALUE inside a transaction block (12+), but the new value cannot
-- be REFERENCED until that transaction commits. The migration runner
-- (packages/db/src/migrate.ts) wraps each file in one transaction, so
-- the index predicate `WHERE scope = 'outcome'` in 0088 would fail with
-- "unsafe use of new value of enum type" if it shared this file.
--
-- IF NOT EXISTS keeps a partial re-run (e.g. after a failed deploy)
-- idempotent.

ALTER TYPE boosted_odds_scope ADD VALUE IF NOT EXISTS 'outcome';
