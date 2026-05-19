-- 0068_zillapass_set_3.sql
--
-- ZillaPass — third task set. Three daily counters, one per pinned
-- esport (CS2, Dota 2, LoL). All currency-agnostic; a USDC bet and an
-- OZ bet count the same.
--
-- A ticket counts toward exactly one sport task: the sport every leg
-- shares. Mixed-sport combos / tiples / tippots fire none of these
-- predicates — the user has a clear path to progress (place a bet
-- whose legs all sit on the targeted sport). Singles trivially have
-- one leg, so a single CS2 bet bumps `bets_sport_cs2`. Same-match
-- BetBuilder bets also count, since their legs are bound to one
-- match by construction. Sport slugs are pinned by migrations
-- 0005 / 0007 (cs2 / dota2 / lol — see packages/db/src/seed.ts).
--
--   bets_sport_cs2     — daily. +1 per successful placement where
--                        every leg's match sits under the cs2 sport.
--   bets_sport_dota2   — daily. +1 per successful placement where
--                        every leg's match sits under the dota2 sport.
--   bets_sport_lol     — daily. +1 per successful placement where
--                        every leg's match sits under the lol sport.
--
-- CTAs deep-link to the per-sport page so the card has somewhere to
-- send the user. set_number = 3.

BEGIN;

INSERT INTO zillapass_tasks
    (slug, title, description, target_count, predicate_key, period, sort_order, active, set_number, cta_href, cta_label)
VALUES
    ('place-5-bets-cs2',
     'Place 5 bets on CS2',
     'Place 5 bets today where every leg is from a Counter-Strike 2 match. Singles and pure-CS2 multibets both count. USDC and OZ both count toward progress.',
     5,
     'bets_sport_cs2',
     'daily',
     70,
     true,
     3,
     '/sport/cs2',
     'Open CS2'),
    ('place-5-bets-dota2',
     'Place 5 bets on Dota 2',
     'Place 5 bets today where every leg is from a Dota 2 match. Singles and pure-Dota 2 multibets both count. USDC and OZ both count toward progress.',
     5,
     'bets_sport_dota2',
     'daily',
     80,
     true,
     3,
     '/sport/dota2',
     'Open Dota 2'),
    ('place-5-bets-lol',
     'Place 5 bets on League of Legends',
     'Place 5 bets today where every leg is from a League of Legends match. Singles and pure-LoL multibets both count. USDC and OZ both count toward progress.',
     5,
     'bets_sport_lol',
     'daily',
     90,
     true,
     3,
     '/sport/lol',
     'Open LoL')
ON CONFLICT (slug) DO NOTHING;

COMMIT;
