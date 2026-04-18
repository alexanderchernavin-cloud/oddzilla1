-- Fallback sport for matches whose Oddin fixture lookup fails. Before this
-- migration the auto-mapper dumped those into `cs2`, which polluted the CS2
-- catalog page with eFootball / soccer test data like "Chelsea vs Man City"
-- that actually came from Oddin's integration broker under tournaments the
-- REST API doesn't resolve.
--
-- Strategy:
--   1. Create a hidden `unclassified` sport (active=FALSE → not listed on
--      the public catalog) and its dummy category.
--   2. Move every tournament currently rooted under a placeholder URN
--      (`od:tournament:placeholder-sport-%`) under that sport.
--   3. Leave non-MVP markets in place — we don't cascade-delete them here
--      because `ticket_selections.market_id` and `settlements.market_id` do
--      not have ON DELETE CASCADE; instead the read-side filters to
--      provider_market_id IN (1, 4). New messages for those markets are
--      already dropped by feed-ingester's isSupportedMarket gate.

INSERT INTO sports (provider, provider_urn, slug, name, kind, active)
VALUES ('internal', 'internal:sport:unclassified', 'unclassified', 'Unclassified', 'esport', FALSE)
ON CONFLICT (provider, provider_urn) DO UPDATE SET active = FALSE;

INSERT INTO categories (sport_id, provider_urn, slug, name, is_dummy, active)
SELECT s.id, 'internal:category:unclassified-auto', 'auto', 'Auto', TRUE, FALSE
FROM sports s WHERE s.slug = 'unclassified'
ON CONFLICT (sport_id, slug) DO NOTHING;

UPDATE tournaments t
SET category_id = (
  SELECT c.id FROM categories c
  JOIN sports s ON s.id = c.sport_id
  WHERE s.slug = 'unclassified' AND c.slug = 'auto'
  LIMIT 1
)
WHERE t.provider_urn LIKE 'od:tournament:placeholder-sport-%';
