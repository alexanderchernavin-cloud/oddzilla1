-- Drop the Cyrillic-named category rows left behind by the feed language
-- switch.
--
-- The Fonbet line was read from fonbet.kz in Russian until 2026-09-04,
-- when it moved to fon.bet in English. Category names come from the
-- segment-name prefix, so the English feed created a fresh row for every
-- country and competition and the Russian ones were orphaned in place:
-- "Швеция" beside "Sweden", "Суперкубок" beside "Super Cup". They are
-- pure duplicates, and 211 of them made the sidebar tree and
-- /admin/categories substantially noisier than the real offer.
--
-- Measured on production immediately before writing this (2026-09-05):
-- 211 categories, of which 197 hold no tournament at all; the remaining
-- 14 carry 18 tournaments, 49 matches and 1054 markets. NONE of it is
-- live offer — every one of those matches has zero markets at status 1,
-- so the catalog's hasActiveMarket gate already hides them — and there
-- are 0 settlements and 0 ticket_selections anywhere underneath. Nothing
-- a bettor can see or has ever bet on is being removed.
--
-- The cascade does the rest: tournaments, matches and markets are all
-- ON DELETE CASCADE from their parent, and `settlements` (which carries
-- no ON DELETE action and would otherwise block this) references none of
-- these markets.
--
-- The NOT EXISTS guard is deliberately kept even though the count is
-- currently zero. This runs at deploy time, not now, and a category that
-- has acquired a real bet between then and now must survive — losing a
-- ticket's market lineage would break its settlement and its history.
-- Anything the guard spares stays visible in /admin/categories, where it
-- can be judged by hand.
DELETE FROM categories c
 WHERE c.name ~ '[А-Яа-яЁё]'
   AND NOT EXISTS (
     SELECT 1
       FROM ticket_selections ts
       JOIN markets mk ON mk.id = ts.market_id
       JOIN matches m ON m.id = mk.match_id
       JOIN tournaments t ON t.id = m.tournament_id
      WHERE t.category_id = c.id
   );
