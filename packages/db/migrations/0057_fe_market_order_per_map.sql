-- 0057_fe_market_order_per_map.sql
--
-- Per-map-number ordering for storefront market tabs. Until this migration,
-- the `map` scope was a single shared list that applied to every Map N tab
-- on the match-detail page (Map 1 / Map 2 / Map 3 all rendered in the same
-- order). Operators now want each map tab independently configurable so
-- they can promote, e.g., "Total kills" to the top of Map 1 but keep the
-- default order on Map 2.
--
-- Approach: extend the scope encoding. The storefront already addresses
-- each map tab by its own id (`map_1`, `map_2`, …) — `deriveScope()` in
-- services/api/src/lib/market-naming.ts. We adopt the same id as the
-- DB scope value so the catalog lookup is a direct Map.get(g.id) per
-- group, no fallback ladder.
--
-- Scope values after this migration:
--   match          — markets WITHOUT a `map` specifier (Match tab + match cards)
--   top            — curated highlights tab (unchanged)
--   map_<N>        — markets carrying `map=<N>`; one row set per map number
--
-- The legacy `map` scope is removed: existing rows are backfilled into
-- map_1 through map_5 (BO5 = the deepest format the supported sports
-- play today) before the CHECK is tightened. Sports whose matches have
-- more than 5 maps fall back to default ordering (provider_market_id asc)
-- on Map 6+ until an admin configures them explicitly. The new CHECK
-- accepts any positive N so a future PR can lift the UI cap without
-- touching the DB.

BEGIN;

-- 1) Drop the existing CHECK so we can backfill the legacy rows with
--    new scope values before re-tightening.
ALTER TABLE fe_market_display_order
  DROP CONSTRAINT IF EXISTS fe_market_display_order_scope_check;

-- 2) Fan each `map` row out to map_1..map_5 with the same display_order.
--    The composite unique (sport_id, scope, provider_market_id) keeps
--    this idempotent on re-runs: ON CONFLICT DO NOTHING lets us re-apply
--    without breaking if a partial backfill landed earlier.
INSERT INTO fe_market_display_order
  (sport_id, scope, provider_market_id, display_order, created_at, updated_at, updated_by)
SELECT
  sport_id,
  'map_' || n AS scope,
  provider_market_id,
  display_order,
  created_at,
  updated_at,
  updated_by
FROM fe_market_display_order
CROSS JOIN generate_series(1, 5) AS gs(n)
WHERE scope = 'map'
ON CONFLICT ON CONSTRAINT fe_market_display_order_sport_scope_market DO NOTHING;

-- 3) Drop the now-redundant legacy `map` rows.
DELETE FROM fe_market_display_order WHERE scope = 'map';

-- 4) Re-tighten the CHECK to the new allowed shape.
--    `match`, `top`, or `map_<positive integer>` — no leading zeros, no
--    empty N. The regex anchors enforce the whole string matches.
ALTER TABLE fe_market_display_order
  ADD CONSTRAINT fe_market_display_order_scope_check
  CHECK (scope IN ('match', 'top') OR scope ~ '^map_[1-9][0-9]*$');

COMMIT;
