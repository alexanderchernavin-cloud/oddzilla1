-- Sub-event market scopes (Fonbet halves, corners, cards, player props).
--
-- The match-detail page has grouped markets into tabs by SUB-EVENT since
-- the Fonbet line landed: a football fixture renders Match / 1st half /
-- 2nd half / Corners / 1st half corners / Yellow cards / Players, derived
-- at request time from the market's `variant` specifier plus the label
-- prefix its description carries ("1st half corners: Match result").
--
-- Those tabs were not configurable. `fe_market_display_order.scope` and
-- `fe_market_groups.scope` accepted only 'match', 'top', 'map_<N>' and
-- 'custom_<key>', so the backoffice offered every sport the esports tab
-- set — Match plus Map 1..5, which no football match has ever had — and
-- the tabs bettors actually see could be neither ordered nor reordered.
--
-- Scope ids mirror the variant: `fb:100201` -> 'fb_100201',
-- `fb:400100/10100201` -> 'fb_400100_10100201'. Every per-player variant
-- (`fb:<kinds>:<playerId>`) collapses into the single 'fb_players' tab —
-- one tab per footballer is not a tab strip. The grammar lives in
-- packages/types/src/market-scope.ts; these CHECKs mirror it.
--
-- Additive only: no existing row changes, and a sport with no rows keeps
-- the default tab order it has today.

ALTER TABLE fe_market_display_order
  DROP CONSTRAINT IF EXISTS fe_market_display_order_scope_check;
ALTER TABLE fe_market_display_order
  ADD CONSTRAINT fe_market_display_order_scope_check
  CHECK (
    scope IN ('match', 'top')
    OR scope ~ '^map_[1-9][0-9]*$'
    OR scope ~ '^custom_[a-z0-9]{4,32}$'
    OR scope ~ '^fb_(players|[0-9]+(_[0-9]+)*)$'
  );

ALTER TABLE fe_market_groups
  DROP CONSTRAINT IF EXISTS fe_market_groups_scope_check;
ALTER TABLE fe_market_groups
  ADD CONSTRAINT fe_market_groups_scope_check
  CHECK (
    scope IN ('match', 'top')
    OR scope ~ '^map_[1-9][0-9]*$'
    OR scope ~ '^custom_[a-z0-9]{4,32}$'
    OR scope ~ '^fb_(players|[0-9]+(_[0-9]+)*)$'
  );

-- The label CHECK is unchanged in effect but restated for clarity: only
-- custom groups carry an operator-authored label. A sub-event tab's label
-- is the feed's own ("1st half"), so it stays derived rather than stored —
-- if Fonbet renames a sub-event, the tab follows without a backfill.
