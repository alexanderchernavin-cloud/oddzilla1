-- 0071_bettor_promo_visibility.sql
--
-- Per-bettor cascade visibility for promotional features.
--
-- Same shape as 0070_bettor_odds_adjustment_config but with TWO extra
-- dimensions:
--   * promo_kind  — which promo this row toggles (zillaflash / combi_boost)
--   * visible BOOLEAN  — show or hide for this bettor at this scope
--
-- Cascade resolution per (user, promo_kind):
--     match > tournament > sport > global
-- First explicit row wins. Without any row the bettor sees the standard
-- (visible=true) behaviour — opt-out model.
--
-- One unified table instead of two per-promo tables because:
--   * Cascade resolver code is identical — one engine handles both
--   * Single admin UI tree shows both promo toggles per row
--   * Easy to extend to a 3rd promo (e.g. BigWin badge, ZillaPass quest
--     visibility) without a new migration

BEGIN;

-- ── 1. Enums ─────────────────────────────────────────────────────────
CREATE TYPE bettor_promo_kind AS ENUM ('zillaflash', 'combi_boost');

-- Note: scope enum is distinct from bettor_odds_adjustment_scope because
-- the two features will evolve their scope sets independently. Reusing
-- the same enum would couple their migrations forever.
CREATE TYPE bettor_promo_scope AS ENUM ('global', 'sport', 'tournament', 'match');

-- ── 2. Config table ──────────────────────────────────────────────────
CREATE TABLE bettor_promo_visibility_config (
  id              bigserial   PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  promo_kind      bettor_promo_kind NOT NULL,
  scope           bettor_promo_scope NOT NULL,
  sport_id        integer     REFERENCES sports(id)               ON DELETE CASCADE,
  tournament_id   integer     REFERENCES tournaments(id)          ON DELETE CASCADE,
  match_id        bigint      REFERENCES matches(id)              ON DELETE CASCADE,
  visible         boolean     NOT NULL,
  updated_by      uuid        REFERENCES users(id)                ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bettor_promo_visibility_scope_consistency CHECK (
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

-- One row per (user, promo_kind, scope, ref-id). Partial unique indexes
-- per scope tier so the cascade lookup is a single index probe per tier
-- without a sentinel for the NULL columns the other scopes leave unset.
-- The promo_kind dimension rides on every index so the same user can
-- have independent rows for zillaflash vs combi_boost on the same scope.
CREATE UNIQUE INDEX bettor_promo_visibility_user_global_uniq
  ON bettor_promo_visibility_config (user_id, promo_kind)
  WHERE scope = 'global';
CREATE UNIQUE INDEX bettor_promo_visibility_user_sport_uniq
  ON bettor_promo_visibility_config (user_id, promo_kind, sport_id)
  WHERE scope = 'sport';
CREATE UNIQUE INDEX bettor_promo_visibility_user_tournament_uniq
  ON bettor_promo_visibility_config (user_id, promo_kind, tournament_id)
  WHERE scope = 'tournament';
CREATE UNIQUE INDEX bettor_promo_visibility_user_match_uniq
  ON bettor_promo_visibility_config (user_id, promo_kind, match_id)
  WHERE scope = 'match';

-- Per-user fetch index for the placement / catalog read path: one query
-- pulls every row this bettor has across both promo_kinds; the engine
-- partitions them in memory. Typical payload is tiny (most users have
-- 0 rows; tagged VIPs / sharps might have 2-6).
CREATE INDEX bettor_promo_visibility_user_idx
  ON bettor_promo_visibility_config (user_id);

COMMIT;
