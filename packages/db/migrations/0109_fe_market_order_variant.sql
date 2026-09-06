-- Curated tabs pick a market, not a market TYPE.
--
-- fe_market_display_order is keyed by provider_market_id, which is the
-- catalogue TABLE — "Total {threshold}" — not the market a bettor sees.
-- Fonbet reuses one table across every sub-event and distinguishes them
-- by the `variant` specifier, so football's ~470 markets collapse to 14
-- ids: the Top picker offered "Total" once and there was no way to
-- feature "Corners: Total" or "1st half: Match result" at all.
--
-- `variant` is that specifier, and it narrows a row to one sub-event.
-- The empty string keeps its existing meaning — ANY copy of that market
-- type, resolved by the representative-pick the storefront already does
-- (prefer the match-scope copy, else the lowest map). That is what every
-- pre-existing row means, so this migration backfills nothing and no
-- configured tab changes: an esports row for a market that only ever
-- appears with an Oddin variant (`way:two`, `mr:12`) keeps resolving
-- exactly as it did.
--
-- Meaningful only for the curated scopes (`top`, `custom_<key>`). The
-- feed tabs (`match`, `map_<N>`, `fb_<kinds>`) already ARE one sub-event,
-- so their rows leave it empty — the same convention
-- boosted_odds_config.outcome_id follows for its one scope tier, rather
-- than a CHECK that needs rebuilding every time a tier is added.

ALTER TABLE fe_market_display_order
  ADD COLUMN variant TEXT NOT NULL DEFAULT '';

-- Re-key: the same market type can now appear on a curated tab once per
-- sub-event ("Total" on Match AND on Corners), which the old unique
-- forbade.
ALTER TABLE fe_market_display_order
  DROP CONSTRAINT IF EXISTS fe_market_display_order_sport_scope_market;
ALTER TABLE fe_market_display_order
  ADD CONSTRAINT fe_market_display_order_sport_scope_market
  UNIQUE (sport_id, scope, provider_market_id, variant);
