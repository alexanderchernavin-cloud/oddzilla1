-- 0052_riskzilla_live_bet_delay.sql
--
-- RiskZilla — live bet acceptance delay with sport / tournament / match
-- cascade overrides. Sits alongside the existing per-user
-- users.bet_delay_seconds: the effective delay at placement is
-- max(users.bet_delay_seconds, live_cascade_delay) when ANY leg of the
-- ticket is on a live match; pure-prematch placements keep the
-- per-user value untouched (cascade contributes 0).
--
-- Cascade resolution per LIVE leg:
--     match  > tournament > sport > global
-- First non-NULL override wins. Across legs we take MAX so the worst-
-- case window for any leg gates the whole ticket.
--
-- Schema choice: each scope-tier ref is its own typed FK column rather
-- than a single TEXT scope_ref_id. This buys us ON DELETE CASCADE for
-- free (an admin who clears a match-level override implicitly when the
-- match closes, or a stale tournament that gets removed) and lets the
-- consistency check be cheap arithmetic instead of a varchar lookup.

BEGIN;

-- ── 1. Scope enum ──────────────────────────────────────────────────────
-- New enum (vs. odds_scope) because the existing odds_scope has
-- `market_type` and lacks `match`. The two cascades aren't compatible.
CREATE TYPE live_delay_scope AS ENUM ('global', 'sport', 'tournament', 'match');

-- ── 2. Config table ────────────────────────────────────────────────────
CREATE TABLE riskzilla_live_delay_config (
  id              bigserial   PRIMARY KEY,
  scope           live_delay_scope NOT NULL,
  sport_id        integer     REFERENCES sports(id)      ON DELETE CASCADE,
  tournament_id   integer     REFERENCES tournaments(id) ON DELETE CASCADE,
  match_id        bigint      REFERENCES matches(id)     ON DELETE CASCADE,
  delay_seconds   smallint    NOT NULL,
  updated_by      uuid        REFERENCES users(id)       ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT riskzilla_live_delay_seconds_range
    CHECK (delay_seconds >= 0 AND delay_seconds <= 300),
  CONSTRAINT riskzilla_live_delay_scope_consistency CHECK (
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

-- One row per scope-key. Partial unique indexes per scope so the cascade
-- lookup is "at most one row per (scope, refId)" without inventing a
-- placeholder for the NULL columns the other scopes use.
CREATE UNIQUE INDEX riskzilla_live_delay_global_unique
  ON riskzilla_live_delay_config ((scope = 'global'))
  WHERE scope = 'global';
CREATE UNIQUE INDEX riskzilla_live_delay_sport_unique
  ON riskzilla_live_delay_config (sport_id)
  WHERE scope = 'sport';
CREATE UNIQUE INDEX riskzilla_live_delay_tournament_unique
  ON riskzilla_live_delay_config (tournament_id)
  WHERE scope = 'tournament';
CREATE UNIQUE INDEX riskzilla_live_delay_match_unique
  ON riskzilla_live_delay_config (match_id)
  WHERE scope = 'match';

-- Default global = 5 seconds (matches the spec).
INSERT INTO riskzilla_live_delay_config (scope, delay_seconds)
VALUES ('global', 5);

COMMIT;
