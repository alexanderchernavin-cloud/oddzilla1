-- 0093_boosted_odds_competitor_markets.sql
--
-- Team (competitor) boosts get a market-scope choice.
--
-- Until now a competitor rule boosted EVERY market of every match the
-- team plays — including markets about the opponent, and symmetric
-- markets (totals, correct score) that aren't "about" either side. That
-- is often what an operator wants (a promo on a marquee team's fixtures)
-- but not always: "boost Falcons" frequently means "make Falcons' own
-- prices attractive", not "make this whole match cheaper".
--
--   'all'       — current behaviour, every market of the team's matches.
--   'team_only' — only the team's OWN outcome, and only in team-shaped
--                 markets (provider_market_id 1 = match winner, 4 = map
--                 winner, where outcome "1" is the home competitor and
--                 "2" the away one). Priced like an outcome-scope rule:
--                 the delta comes out of that outcome's own implied
--                 probability, so the opponent's price does not move.
--
-- NOT NULL DEFAULT 'all' so every pre-existing row keeps exactly the
-- behaviour it had. Meaningful only for scope='competitor'; left at the
-- default and ignored for other scopes (same convention outcome_id
-- follows) rather than adding a CHECK that would have to be rebuilt
-- every time a scope tier is added.
--
-- Team-shaped detection deliberately lives in ONE place shared by the
-- server and the browser — isTeamShapedMarket in
-- packages/types/src/boosted-odds.ts. A team_only rule is delivered to
-- the client as "boost outcome N wherever the market is team-shaped"
-- rather than as a list of market ids: live matches mint new market rows
-- as maps start, and an enumerated list would silently miss them (the
-- bug the per-market flattening caused in 0086, fixed 2026-08-26).

BEGIN;

ALTER TABLE boosted_odds_config
  ADD COLUMN competitor_markets text NOT NULL DEFAULT 'all';

ALTER TABLE boosted_odds_config
  ADD CONSTRAINT boosted_odds_competitor_markets_values
    CHECK (competitor_markets IN ('all', 'team_only'));

COMMIT;
