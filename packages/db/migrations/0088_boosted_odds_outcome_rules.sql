-- 0088_boosted_odds_outcome_rules.sql
--
-- Selection-level ZillaBoost. Completes the 'outcome' scope added in
-- 0087: a rule may now target ONE (market, outcome) cell instead of the
-- whole market, so an operator can boost "Team Falcons to win map 2"
-- without moving the price of the opposing side.
--
-- Keying: an outcome is identified by (market_id, outcome_id) — the
-- market_outcomes primary key — so the scope reuses the existing
-- market_id column and adds outcome_id alongside it. That keeps the
-- market_id FK (ON DELETE CASCADE) doing the cleanup when a market row
-- disappears, and leaves boosted_odds_market_uniq untouched: a market
-- rule (scope='market') and any number of selection rules
-- (scope='outcome') on the same market live in different partial
-- indexes.
--
-- No FK on (market_id, outcome_id) -> market_outcomes on purpose.
-- Validating one would take SHARE ROW EXCLUSIVE on market_outcomes,
-- which the feed writes to continuously; the lock queue that builds
-- behind it is exactly the failure mode migration 0023 was added to fix.
-- The admin route verifies the outcome row exists at write time, and an
-- outcome that later leaves the market simply stops resolving (the
-- pricing path only ever reads live, priced outcomes) — the rule row is
-- inert, not dangerous.
--
-- Boost math for the new scope is boostSelectionKeys in
-- packages/types/src/netwinstable.ts: the boost_pct key delta comes out
-- of the boosted outcome's own implied probability instead of being
-- spread across the market. Two clamps bound it — the market key can
-- still never reach fair (1.0), and no single outcome may lose more than
-- half its own probability. A selection rule REPLACES any coarser rule
-- for its market rather than stacking with it (see quoteMarketBoost);
-- composing them would push the book past fair.

BEGIN;

ALTER TABLE boosted_odds_config
  ADD COLUMN outcome_id text;

ALTER TABLE boosted_odds_config
  ADD CONSTRAINT boosted_odds_outcome_id_len
    CHECK (outcome_id IS NULL OR (length(outcome_id) BETWEEN 1 AND 64));

-- Rebuild the scope/ref consistency check with the new tier. Every
-- pre-existing scope additionally pins outcome_id IS NULL so a stray
-- value can't ride along on a market rule and silently narrow it.
ALTER TABLE boosted_odds_config
  DROP CONSTRAINT boosted_odds_scope_consistency;

ALTER TABLE boosted_odds_config
  ADD CONSTRAINT boosted_odds_scope_consistency CHECK (
    (scope = 'sport'
       AND sport_id IS NOT NULL AND tournament_id IS NULL AND match_id IS NULL
       AND competitor_id IS NULL AND market_id IS NULL AND outcome_id IS NULL) OR
    (scope = 'tournament'
       AND sport_id IS NULL AND tournament_id IS NOT NULL AND match_id IS NULL
       AND competitor_id IS NULL AND market_id IS NULL AND outcome_id IS NULL) OR
    (scope = 'match'
       AND sport_id IS NULL AND tournament_id IS NULL AND match_id IS NOT NULL
       AND competitor_id IS NULL AND market_id IS NULL AND outcome_id IS NULL) OR
    (scope = 'competitor'
       AND sport_id IS NULL AND tournament_id IS NULL AND match_id IS NULL
       AND competitor_id IS NOT NULL AND market_id IS NULL AND outcome_id IS NULL) OR
    (scope = 'market'
       AND sport_id IS NULL AND tournament_id IS NULL AND match_id IS NULL
       AND competitor_id IS NULL AND market_id IS NOT NULL AND outcome_id IS NULL) OR
    (scope = 'outcome'
       AND sport_id IS NULL AND tournament_id IS NULL AND match_id IS NULL
       AND competitor_id IS NULL AND market_id IS NOT NULL AND outcome_id IS NOT NULL)
  );

-- One rule per (market, outcome).
CREATE UNIQUE INDEX boosted_odds_outcome_uniq
  ON boosted_odds_config (market_id, outcome_id) WHERE scope = 'outcome';

COMMIT;
