-- 0096_riskzilla_velocity_decision
--
-- Adds the `rejected_velocity` decision to the RiskZilla decision enum so
-- per-account velocity caps (placements per minute, distinct matches per
-- minute; migration 0097) land in `riskzilla_event_log` like every other
-- gate and show up in the betticker / bets viewers.
--
-- Its own file on purpose: Postgres forbids REFERENCING a new enum value
-- in the transaction that added it, and the migration runner wraps each
-- file in one transaction (same reason 0087 is split from 0088).

ALTER TYPE riskzilla_decision ADD VALUE IF NOT EXISTS 'rejected_velocity';
