-- 0020_fe_market_order_scope.sql
--
-- Extends fe_market_display_order from a flat per-sport list to per-sport
-- per-scope lists. Three scopes exist on the storefront:
--
--   match — markets without a `map` specifier (the "Match" tab)
--   map   — markets with a `map` specifier; one ordering applies to every
--           map_N tab (Map 1, Map 2, … all share the order)
--   top   — curated highlights tab. NEW: rendered both on the match-detail
--           page and inline on match list cards. Empty by default — only
--           shows what admins explicitly add.
--
-- Migration approach: add a scope column defaulting to 'match' (which is
-- the only scope that actually existed before — pre-0020 the order was
-- only ever consulted for the Match group in catalog routes), drop the
-- old (sport_id, provider_market_id) unique, add the new scoped one.

ALTER TABLE fe_market_display_order
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'match'
  CHECK (scope IN ('match', 'map', 'top'));

-- 0019 wrote the original UNIQUE inline (no name), so PG auto-generated
-- `fe_market_display_order_sport_id_provider_market_id_key`. The Drizzle
-- schema uses an explicit `unique("fe_market_display_order_sport_market")`
-- name, which is what `pnpm db:push` would create. Drop both with
-- IF EXISTS so this migration applies cleanly regardless of how 0019
-- landed (drizzle-kit push vs. our hand-written migrate runner).
ALTER TABLE fe_market_display_order
  DROP CONSTRAINT IF EXISTS fe_market_display_order_sport_market;
ALTER TABLE fe_market_display_order
  DROP CONSTRAINT IF EXISTS fe_market_display_order_sport_id_provider_market_id_key;

ALTER TABLE fe_market_display_order
  ADD CONSTRAINT fe_market_display_order_sport_scope_market
  UNIQUE (sport_id, scope, provider_market_id);

DROP INDEX IF EXISTS fe_market_display_order_sport_idx;
CREATE INDEX fe_market_display_order_sport_scope_idx
  ON fe_market_display_order (sport_id, scope, display_order);
