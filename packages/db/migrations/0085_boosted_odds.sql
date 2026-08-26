-- 0085_boosted_odds.sql
--
-- Custom Boosted Odds — operator-curated odds boosts pinned to any
-- catalog entity: sport, tournament, match, competitor (team), or a
-- single market. Unlike ZillaFlash (engine-rotated, ephemeral offers)
-- these are explicit admin rules with an optional end time and an
-- optional Min Risk Score gate (bettors whose users.risk_score is
-- BELOW the threshold do not receive the boost).
--
-- Boost semantics match ZillaFlash exactly: boost_pct is a
-- Netwinstable key delta in percentage points, applied to the whole
-- market's outcome set at read time (packages/types/src/netwinstable.ts
-- boostMarketKey), clamped so the book never goes to/below fair. The
-- boosted price is recomputed from live published_odds on every read —
-- nothing is frozen in the rule row.
--
-- Resolution per market (most specific wins):
--     market > match > competitor > tournament > sport
-- Two competitor rules covering the same match (both teams boosted)
-- resolve to the higher boost_pct.
--
-- One rule per (scope, ref) — partial unique per scope tier, mirroring
-- 0070_bettor_odds_adjustment. Editing an entity's boost updates the
-- same row; removing the boost deletes it.

BEGIN;

CREATE TYPE boosted_odds_scope AS ENUM (
  'sport',
  'tournament',
  'match',
  'competitor',
  'market'
);

CREATE TABLE boosted_odds_config (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           boosted_odds_scope NOT NULL,
  sport_id        integer     REFERENCES sports(id)       ON DELETE CASCADE,
  tournament_id   integer     REFERENCES tournaments(id)  ON DELETE CASCADE,
  match_id        bigint      REFERENCES matches(id)      ON DELETE CASCADE,
  competitor_id   integer     REFERENCES competitors(id)  ON DELETE CASCADE,
  market_id       bigint      REFERENCES markets(id)      ON DELETE CASCADE,
  -- Netwinstable key delta in percentage points (3.00 = the ZillaFlash
  -- baseline). Bounded well past any realistic promo — the fair-book
  -- clamp in boostMarketKey bites long before 50pp on real books.
  boost_pct       numeric(5,2) NOT NULL,
  -- NULL = boost runs until the rule is deleted (no countdown shown).
  ends_at         timestamptz,
  -- NULL = every bettor receives the boost. Otherwise the bettor's
  -- users.risk_score must be >= this value. Anonymous viewers are
  -- treated as the default risk score (1.000).
  min_risk_score  numeric(4,3),
  updated_by      uuid        REFERENCES users(id)        ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT boosted_odds_pct_range
    CHECK (boost_pct > 0 AND boost_pct <= 50),
  CONSTRAINT boosted_odds_min_rs_range
    CHECK (min_risk_score IS NULL
           OR (min_risk_score >= 0.01 AND min_risk_score <= 10)),
  CONSTRAINT boosted_odds_scope_consistency CHECK (
    (scope = 'sport'
       AND sport_id IS NOT NULL AND tournament_id IS NULL AND match_id IS NULL
       AND competitor_id IS NULL AND market_id IS NULL) OR
    (scope = 'tournament'
       AND sport_id IS NULL AND tournament_id IS NOT NULL AND match_id IS NULL
       AND competitor_id IS NULL AND market_id IS NULL) OR
    (scope = 'match'
       AND sport_id IS NULL AND tournament_id IS NULL AND match_id IS NOT NULL
       AND competitor_id IS NULL AND market_id IS NULL) OR
    (scope = 'competitor'
       AND sport_id IS NULL AND tournament_id IS NULL AND match_id IS NULL
       AND competitor_id IS NOT NULL AND market_id IS NULL) OR
    (scope = 'market'
       AND sport_id IS NULL AND tournament_id IS NULL AND match_id IS NULL
       AND competitor_id IS NULL AND market_id IS NOT NULL)
  )
);

-- One rule per (scope, ref).
CREATE UNIQUE INDEX boosted_odds_sport_uniq
  ON boosted_odds_config (sport_id) WHERE scope = 'sport';
CREATE UNIQUE INDEX boosted_odds_tournament_uniq
  ON boosted_odds_config (tournament_id) WHERE scope = 'tournament';
CREATE UNIQUE INDEX boosted_odds_match_uniq
  ON boosted_odds_config (match_id) WHERE scope = 'match';
CREATE UNIQUE INDEX boosted_odds_competitor_uniq
  ON boosted_odds_config (competitor_id) WHERE scope = 'competitor';
CREATE UNIQUE INDEX boosted_odds_market_uniq
  ON boosted_odds_config (market_id) WHERE scope = 'market';

-- Per-leg audit + bet-delay drift skip: a leg placed at a custom
-- boosted price records which rule priced it. The bet-delay worker
-- skips the per-leg drift tripwire for boosted legs — odds_at_placement
-- is deliberately above the raw published price, so comparing the two
-- would false-reject every live boosted bet whose boost exceeds the
-- drift tolerance. ON DELETE SET NULL so removing a rule never touches
-- settled history (settlement pays from odds_at_placement regardless).
ALTER TABLE ticket_selections
  ADD COLUMN boost_rule_id uuid REFERENCES boosted_odds_config(id) ON DELETE SET NULL;

COMMIT;
