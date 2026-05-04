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

ALTER TABLE fe_market_display_order
  DROP CONSTRAINT fe_market_display_order_sport_market;

ALTER TABLE fe_market_display_order
  ADD CONSTRAINT fe_market_display_order_sport_scope_market
  UNIQUE (sport_id, scope, provider_market_id);

DROP INDEX IF EXISTS fe_market_display_order_sport_idx;
CREATE INDEX fe_market_display_order_sport_scope_idx
  ON fe_market_display_order (sport_id, scope, display_order);
