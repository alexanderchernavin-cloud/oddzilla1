-- 0063_zillapass_task_wording.sql
--
-- Re-words the day-1 + day-2 ZillaPass tasks to clarify the singles-
-- only gate on bets_prematch / bets_live and to polish copy across
-- the board. Idempotent — UPDATE-by-slug; running twice produces the
-- same final state.
--
-- The original INSERTs in 0061 + 0062 were updated in place so fresh
-- installs ship with the new wording directly; this migration brings
-- already-applied rows up to the same final state. Either path lands
-- at identical content.

BEGIN;

UPDATE zillapass_tasks
SET title = 'Complete your profile',
    description = 'Pick a nickname and an avatar in your community profile to make your account yours.'
WHERE slug = 'profile-complete';

UPDATE zillapass_tasks
SET title = 'Browse 5 sports',
    description = 'Open the page for 5 different sports today.'
WHERE slug = 'open-5-sports';

UPDATE zillapass_tasks
SET title = 'View 5 matches from 5 sports',
    description = 'Open 5 different matches today, each from a different sport.'
WHERE slug = 'open-5-matches-different-sports';

UPDATE zillapass_tasks
SET title = 'Place 5 prematch singles',
    description = 'Place 5 single bets on prematch markets today. Combos and multibets don''t count. USDC and OZ both count toward progress.'
WHERE slug = 'place-5-prematch-bets';

UPDATE zillapass_tasks
SET title = 'Place 5 live singles',
    description = 'Place 5 single bets on live matches today. Combos and multibets don''t count. USDC and OZ both count toward progress.'
WHERE slug = 'place-5-live-bets';

UPDATE zillapass_tasks
SET title = 'Switch market tabs 10 times',
    description = 'Switch between the Match, Map, and Top market tabs on a match page 10 times today.'
WHERE slug = 'change-market-tab-10';

COMMIT;
