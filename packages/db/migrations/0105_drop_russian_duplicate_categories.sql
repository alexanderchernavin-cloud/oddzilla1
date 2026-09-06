-- Drop the Cyrillic-named category rows left behind by the feed language
-- switch — the EMPTY ones.
--
-- The Fonbet line was read from fonbet.kz in Russian until 2026-09-04,
-- when it moved to fon.bet in English. Category names come from the
-- segment-name prefix, so the English feed created a fresh row for every
-- country and competition and the Russian one was orphaned beside it:
-- "Швеция" next to "Sweden", "Суперкубок" next to "Super Cup". 211 of
-- them made the sidebar tree and /admin/categories substantially noisier
-- than the real offer.
--
-- Measured on production 2026-09-05: 211 such categories, of which 197
-- hold no tournament at all. The other 14 carry 18 tournaments, 49
-- matches and 1054 markets. None of that is live offer — every one of
-- those matches has zero markets at status 1, so the catalog's
-- hasActiveMarket gate already hides them — and there are 0 settlements
-- and 0 ticket_selections anywhere underneath.
--
-- **Only the 197 empty ones are deleted, and the FK is why.** The first
-- cut of this migration deleted on the Cyrillic name alone and failed at
-- deploy with `matches_tournament_id_fkey`: categories cascade to
-- tournaments, but `matches.tournament_id` carries NO on-delete action,
-- so a tournament holding matches cannot be removed. That constraint is
-- correct — a match is the thing tickets, settlements and odds history
-- hang off, and it should not disappear because somebody tidied a
-- category — so this migration is narrowed to fit it rather than the
-- constraint being worked around. The transaction rolled back cleanly and
-- nothing was half-applied.
--
-- The remaining 14 stay visible in /admin/categories. They carry no
-- bettable offer, so they cost nothing but a row in a list, and removing
-- them means deleting real match rows: a heavier operation, with its own
-- FK chain (match_sportradar_ids, feed_messages, markets, odds_history
-- partitions), that deserves its own deliberate change rather than a
-- rider on this one.
--
-- The NOT EXISTS ticket guard is kept even though the count is currently
-- zero. This runs at deploy time, not authoring time, and a category that
-- has acquired a real bet in between must survive.
DELETE FROM categories c
 WHERE c.name ~ '[А-Яа-яЁё]'
   AND NOT EXISTS (
     SELECT 1 FROM tournaments t WHERE t.category_id = c.id
   )
   AND NOT EXISTS (
     SELECT 1
       FROM ticket_selections ts
       JOIN markets mk ON mk.id = ts.market_id
       JOIN matches m ON m.id = mk.match_id
       JOIN tournaments t ON t.id = m.tournament_id
      WHERE t.category_id = c.id
   );
