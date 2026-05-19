-- 0068_bettor_odds_adjustment.sql
--
-- Per-bettor odds adjustment with cascade overrides.
--
-- Mirrors the shape of 0052_riskzilla_live_bet_delay: every row is a
-- single override pinned to one scope-tier, the cascade is resolved at
-- placement / catalog read time, and the partial unique indexes make
-- the "at most one row per (user, scope, ref)" rule a DB invariant.
--
-- Cascade per match (read order):
--     match > tournament > sport > global
-- First non-NULL override on the user wins. Without any override the
-- bettor sees the standard published_odds.
--
-- Math: adjusted_odds = clamp(published_odds * (1 + adjustment_bp/10000),
--                             low = 1.01,
--                             high = 1/probability)  -- "high" only when
-- the outcome has a known probability. The high clamp is the "can't go
-- below zero margin / fair odds" floor the operator asked for: if the
-- raw quote already carries near-zero margin, a generous positive
-- adjustment silently saturates at fair odds rather than letting the
-- bettor place at a -EV-for-house price.
--
-- The bp range [-9000, 9000] (±90%) is generous but bounded: a +90%
-- multiplier is the largest realistic VIP boost, and a -90% multiplier
-- is the worst sharp-punishment knob we'd ever need (the floor at 1.01
-- bites long before that).

BEGIN;

-- ── 1. Scope enum ────────────────────────────────────────────────────
-- New enum (not reused from live_delay_scope) because we want the two
-- features to evolve their scope sets independently — and reusing the
-- same enum across two unrelated tables couples their migrations
-- forever.
CREATE TYPE bettor_odds_adjustment_scope AS ENUM (
  'global',
  'sport',
  'tournament',
  'match'
);

-- ── 2. Config table ──────────────────────────────────────────────────
CREATE TABLE bettor_odds_adjustment_config (
  id              bigserial   PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  scope           bettor_odds_adjustment_scope NOT NULL,
  sport_id        integer     REFERENCES sports(id)               ON DELETE CASCADE,
  tournament_id   integer     REFERENCES tournaments(id)          ON DELETE CASCADE,
  match_id        bigint      REFERENCES matches(id)              ON DELETE CASCADE,
  adjustment_bp   integer     NOT NULL,
  updated_by      uuid        REFERENCES users(id)                ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bettor_odds_adjustment_bp_range
    CHECK (adjustment_bp >= -9000 AND adjustment_bp <= 9000),
  CONSTRAINT bettor_odds_adjustment_scope_consistency CHECK (
    (scope = 'global'
       AND sport_id IS NULL AND tournament_id IS NULL AND match_id IS NULL) OR
    (scope = 'sport'
       AND sport_id IS NOT NULL AND tournament_id IS NULL AND match_id IS NULL) OR
    (scope = 'tournament'
       AND sport_id IS NULL AND tournament_id IS NOT NULL AND match_id IS NULL) OR
    (scope = 'match'
       AND sport_id IS NULL AND tournament_id IS NULL AND match_id IS NOT NULL)
  )
);

-- One row per (user, scope, ref-id). Partial unique indexes per scope
-- tier mean the cascade lookup is a single index probe per tier without
-- inventing a sentinel for the NULL columns the other scopes leave unset.
CREATE UNIQUE INDEX bettor_odds_adjustment_user_global_uniq
  ON bettor_odds_adjustment_config (user_id)
  WHERE scope = 'global';
CREATE UNIQUE INDEX bettor_odds_adjustment_user_sport_uniq
  ON bettor_odds_adjustment_config (user_id, sport_id)
  WHERE scope = 'sport';
CREATE UNIQUE INDEX bettor_odds_adjustment_user_tournament_uniq
  ON bettor_odds_adjustment_config (user_id, tournament_id)
  WHERE scope = 'tournament';
CREATE UNIQUE INDEX bettor_odds_adjustment_user_match_uniq
  ON bettor_odds_adjustment_config (user_id, match_id)
  WHERE scope = 'match';

-- One index for the per-user fetch path at placement / catalog read:
-- "give me every override this bettor has, partitioned by scope". The
-- expected payload is tiny (typically 0-4 rows per user), but without
-- the index the lookup falls back to a full table scan filtered by
-- user_id.
CREATE INDEX bettor_odds_adjustment_user_idx
  ON bettor_odds_adjustment_config (user_id);

COMMIT;
