-- 0084_fe_market_groups.sql
--
-- Custom market groups + configurable group (tab) order on the
-- match-detail page.
--
-- Until now the tab set on /match/:id was fixed: Match, one Map N tab
-- per map specifier, and the curated Top tab — with a hard-coded order
-- (Top, Match, Map 1..N). Operators want (a) additional curated tabs of
-- their own ("Kills", "Player props", ...) and (b) control over the
-- order the tabs render in.
--
--   * fe_market_groups — one row per (sport, scope) tab the admin has
--     touched. Two kinds of row:
--       - custom groups: scope = 'custom_<key>' with a NOT NULL label.
--         These are curated tabs exactly like `top` — their market list
--         lives in fe_market_display_order under the same scope string,
--         and the storefront picks one representative market row per
--         provider_market_id (preferring the match-scope copy).
--       - built-in anchors: scope = 'match' | 'top' | 'map_<N>' with a
--         NULL label. These rows exist only to carry display_order when
--         the admin reorders tabs; label/content semantics of built-ins
--         are unchanged.
--     Tabs with a row sort by display_order and render BEFORE tabs
--     without a row (which keep the legacy default order: top, match,
--     map_1..N). A sport with zero rows behaves exactly as before this
--     migration.
--
--   * fe_market_display_order.scope CHECK is relaxed to accept the new
--     'custom_<key>' scope values. Keys are API-generated random
--     [a-z0-9]{12} suffixes — stable across label renames, so renaming
--     a group never orphans its curated market list.
--
-- Deleting a custom group deletes its fe_market_display_order rows in
-- the same API transaction (no FK between the two tables — scope is a
-- plain string on both sides, mirroring how `top` already works).

BEGIN;

CREATE TABLE fe_market_groups (
  id            SERIAL PRIMARY KEY,
  sport_id      INTEGER NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL,
  -- NULL for built-in scopes (Match / Map N / Top keep their default,
  -- localised labels); required for custom groups (the tab title).
  label         TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    UUID REFERENCES users(id),

  CONSTRAINT fe_market_groups_sport_scope UNIQUE (sport_id, scope),
  CONSTRAINT fe_market_groups_scope_check CHECK (
    scope IN ('match', 'top')
    OR scope ~ '^map_[1-9][0-9]*$'
    OR scope ~ '^custom_[a-z0-9]{4,32}$'
  ),
  -- Custom groups must carry a label; built-ins must not (their labels
  -- come from the storefront i18n dictionary).
  CONSTRAINT fe_market_groups_label_check CHECK (
    CASE
      WHEN scope LIKE 'custom\_%' THEN
        label IS NOT NULL AND length(label) BETWEEN 1 AND 40
      ELSE label IS NULL
    END
  )
);

CREATE INDEX fe_market_groups_sport_order_idx
  ON fe_market_groups (sport_id, display_order);

-- Relax the market-ordering scope CHECK so curated lists can live under
-- the new custom scopes. Same shape as the fe_market_groups CHECK above.
ALTER TABLE fe_market_display_order
  DROP CONSTRAINT IF EXISTS fe_market_display_order_scope_check;
ALTER TABLE fe_market_display_order
  ADD CONSTRAINT fe_market_display_order_scope_check
  CHECK (
    scope IN ('match', 'top')
    OR scope ~ '^map_[1-9][0-9]*$'
    OR scope ~ '^custom_[a-z0-9]{4,32}$'
  );

COMMIT;
