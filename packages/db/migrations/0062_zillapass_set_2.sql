-- 0062_zillapass_set_2.sql
--
-- ZillaPass — second daily task set. All three are simple counters
-- (no set dedup needed); the writer increments by 1 per event.
-- Currency-agnostic per product direction: a USDC bet and an OZ bet
-- count the same. Currency-specific variants can ship later as new
-- tasks without code change — predicate_key carries the contract.
--
--   bets_prematch          — daily. +1 per successful SINGLE-bet
--                            placement on a match with status=
--                            'not_started' at placement time. Combos /
--                            tiples / tippots / betbuilder never count
--                            (writer gates on `legCount === 1`, which
--                            is equivalent to betType='single' since
--                            every other product enforces min-2-legs).
--
--   bets_live              — daily. +1 per successful SINGLE-bet
--                            placement on a match with status='live'.
--                            Mutually exclusive with bets_prematch so
--                            one single placement contributes to
--                            exactly one of the two predicates.
--
--   market_tab_changes     — daily. +1 every time the user clicks a
--                            different market scope tab on the match-
--                            detail page (Match / All / Top / Map N).
--                            Re-clicking the active tab is a no-op
--                            client-side (no track call fires).
--                            Frontend doesn't dedup per-day — 10
--                            target_count caps server-side via the
--                            writer's LEAST() clamp.

BEGIN;

INSERT INTO zillapass_tasks
    (slug, title, description, target_count, predicate_key, period, sort_order, active)
VALUES
    ('place-5-prematch-bets',
     'Place 5 prematch singles',
     'Place 5 single bets on prematch markets today. Combos and multibets don''t count. USDC and OZ both count toward progress.',
     5,
     'bets_prematch',
     'daily',
     40,
     true),
    ('place-5-live-bets',
     'Place 5 live singles',
     'Place 5 single bets on live matches today. Combos and multibets don''t count. USDC and OZ both count toward progress.',
     5,
     'bets_live',
     'daily',
     50,
     true),
    ('change-market-tab-10',
     'Switch market tabs 10 times',
     'Switch between the Match, Map, and Top market tabs on a match page 10 times today.',
     10,
     'market_tab_changes',
     'daily',
     60,
     true)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
