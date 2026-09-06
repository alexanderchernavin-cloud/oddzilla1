-- Every match-page tab becomes editable like a custom group.
--
-- Until now the backoffice treated the two kinds of tab as different
-- animals. A CURATED tab (`top`, `custom_<key>`) had opt-in membership: a
-- pool of every market on the sport on the right, add what you want. A
-- FEED tab (`match`, `map_<N>`, `fb_<kinds>`) had none — membership was
-- the feed's call, the screen offered one list, and the only thing an
-- operator could change was the order of what Fonbet had already put
-- there. So there was no way to say "put the corners total on the Match
-- tab", or to drop a market from a tab that carries it.
--
-- `fe_market_display_order` already holds everything needed to express
-- that: since migration 0109 a row names (provider_market_id, variant) —
-- a market TYPE on one SUB-EVENT — which is exactly how a curated tab
-- addresses a market. What was missing is a way to say what the list
-- MEANS on a feed tab, and that is what this column adds:
--
--   'auto'   (default, and what every existing row means): the listed
--            markets render first, in the operator's order, and the
--            tab's own feed markets that nobody listed sort after them.
--            Byte-identical to today's behaviour for a tab whose rows
--            are all wildcard, which is every pre-0109 row.
--
--   'manual': the tab renders exactly the listed markets. Same semantics
--            as `top` and a custom group.
--
-- Defaulting to 'auto' is the load-bearing part. The editor's pool is
-- derived from the CURRENT offer (open matches only — see
-- services/api/src/lib/fe-market-scopes.ts), so a market kind that only
-- shows up on big fixtures is simply absent from the screen on a quiet
-- afternoon. Flipping every configured tab to explicit membership would
-- have silently dropped those from the storefront the next time anyone
-- saved an order. 'manual' is therefore a deliberate per-tab choice an
-- operator makes, not a side effect of using the editor.
--
-- Meaningful only for the feed tabs: `top` and `custom_<key>` have no
-- feed side to auto-fill from, so they behave as 'manual' whatever this
-- column says. Left at the default and ignored there, the same
-- convention boosted_odds_config.competitor_markets follows for its one
-- scope tier, rather than a CHECK that needs rebuilding every time a
-- scope family is added.

ALTER TABLE fe_market_groups
  ADD COLUMN IF NOT EXISTS membership TEXT NOT NULL DEFAULT 'auto';

ALTER TABLE fe_market_groups
  DROP CONSTRAINT IF EXISTS fe_market_groups_membership_check;
ALTER TABLE fe_market_groups
  ADD CONSTRAINT fe_market_groups_membership_check
  CHECK (membership IN ('auto', 'manual'));
