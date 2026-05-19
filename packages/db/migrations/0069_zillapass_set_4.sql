-- 0069_zillapass_set_4.sql
--
-- ZillaPass — fourth task set. Three daily counters keyed on the
-- ticket's bet_type. Currency-agnostic per the same rule as sets 2
-- and 3 — USDC and OZ both count.
--
--   bets_product_combo   — daily. +1 per successful placement with
--                          tickets.bet_type='combo'.
--   bets_product_tiple   — daily. +1 per successful placement with
--                          tickets.bet_type='tiple'.
--   bets_product_tippot  — daily. +1 per successful placement with
--                          tickets.bet_type='tippot'.
--
-- BetBuilder (`bet_type='betbuilder'`, same-match combo product) is
-- intentionally NOT a fourth task here — it'd duplicate set 3's
-- "all legs same sport" semantics for the special case of "all legs
-- same match", which doesn't add a meaningful new quest. Same-match
-- BetBuilder bets still bump the matching sport task in set 3.
--
-- CTAs deep-link to /upcoming because combo / tiple / tippot is a
-- slip-mode decision the user makes after picking matches, not a
-- dedicated landing page. set_number = 4.

BEGIN;

INSERT INTO zillapass_tasks
    (slug, title, description, target_count, predicate_key, period, sort_order, active, set_number, cta_href, cta_label)
VALUES
    ('place-5-combos',
     'Place 5 combo bets',
     'Place 5 combo bets today (two or more legs across different matches, multiplied odds). USDC and OZ both count toward progress.',
     5,
     'bets_product_combo',
     'daily',
     100,
     true,
     4,
     '/upcoming',
     'Build a combo'),
    ('place-5-tiples',
     'Place 5 Tiple bets',
     'Place 5 Tiple bets today (multiple legs, partial wins still pay). USDC and OZ both count toward progress.',
     5,
     'bets_product_tiple',
     'daily',
     110,
     true,
     4,
     '/upcoming',
     'Build a Tiple'),
    ('place-5-tippots',
     'Place 5 Tippot bets',
     'Place 5 Tippot bets today (large multi-leg slip with a Tippot all-wins multiplier). USDC and OZ both count toward progress.',
     5,
     'bets_product_tippot',
     'daily',
     120,
     true,
     4,
     '/upcoming',
     'Build a Tippot')
ON CONFLICT (slug) DO NOTHING;

COMMIT;
