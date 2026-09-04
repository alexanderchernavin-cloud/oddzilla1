-- Categories that are carried in the tree but kept out of the match lists.
--
-- Fonbet files EA FC simulations ("FC 26. ESportsBattle. La Liga. 2x4 min.")
-- under the real Football sport, so 10 of Football's 23 live matches and
-- 184 of its upcoming ones were computer-played 2x4-minute games sitting
-- above the actual football offer in the lobby, the /live list and the
-- sport page (measured on production 2026-09-04). The same shape
-- exists elsewhere in the Fonbet line: NBA 2K26 under Basketball, NHL 26
-- under Ice Hockey.
--
-- Deliberately NOT `active = false`: these matches are real, bettable and
-- settle normally. The flag only removes them from the lists a bettor gets
-- WITHOUT asking. The sidebar tree still carries the category, and
-- selecting it (/sport/<slug>?category=<id>) or one of its tournaments
-- shows every match under it — the whole point is that the offer stays
-- reachable, just not in the way.
ALTER TABLE categories
  ADD COLUMN hidden_from_lists BOOLEAN NOT NULL DEFAULT FALSE;

-- Seed the EA FC categories the operator asked for. Matched on the exact
-- shape Fonbet uses for the title year ("FC 24", "FC 26") rather than a
-- loose LIKE 'FC %', which would also catch a real club category. Every
-- other simulation category (NBA 2K26, NHL 26) is left alone — those are
-- one toggle away on /admin/categories, which is an operator call, not
-- a migration's.
UPDATE categories
   SET hidden_from_lists = TRUE
 WHERE name ~ '^FC [0-9]{2}$';
