-- Per-kind ZillaFlash tunables. Splits the single hardcoded
-- ZILLAFLASH_KEY_DELTA_PCT constant into separate prematch + live
-- values (operators want a tighter discount on live where odds move
-- fast, vs. a fatter prematch sweetener), and adds a tournament
-- risk-tier window per kind so the engine can pull live boosts from
-- a wider tier band than prematch (or the reverse) without code
-- changes.
--
-- Defaults preserve current behaviour: both kinds at -3 pp and tiers
-- 1..3, matching the hardcoded constants the engine shipped with
-- (migration 0055 + ZILLAFLASH_KEY_DELTA_PCT). Bounds are wide:
-- 0..50 pp on key delta (50 pp = aggressive subsidy, well past
-- any realistic operator setting), 1..32 on tiers (the risk_tier
-- column allows 1..32 per the riskzilla schema; CLAUDE.md notes
-- the headroom).

ALTER TABLE zillaflash_config
  ADD COLUMN prematch_key_delta_pct NUMERIC(4, 2) NOT NULL DEFAULT 3.00
    CHECK (prematch_key_delta_pct BETWEEN 0 AND 50),
  ADD COLUMN live_key_delta_pct NUMERIC(4, 2) NOT NULL DEFAULT 3.00
    CHECK (live_key_delta_pct BETWEEN 0 AND 50),
  ADD COLUMN prematch_min_tier INTEGER NOT NULL DEFAULT 1
    CHECK (prematch_min_tier BETWEEN 1 AND 32),
  ADD COLUMN prematch_max_tier INTEGER NOT NULL DEFAULT 3
    CHECK (prematch_max_tier BETWEEN 1 AND 32),
  ADD COLUMN live_min_tier INTEGER NOT NULL DEFAULT 1
    CHECK (live_min_tier BETWEEN 1 AND 32),
  ADD COLUMN live_max_tier INTEGER NOT NULL DEFAULT 3
    CHECK (live_max_tier BETWEEN 1 AND 32);

ALTER TABLE zillaflash_config
  ADD CONSTRAINT zillaflash_prematch_tier_order
    CHECK (prematch_min_tier <= prematch_max_tier),
  ADD CONSTRAINT zillaflash_live_tier_order
    CHECK (live_min_tier <= live_max_tier);
