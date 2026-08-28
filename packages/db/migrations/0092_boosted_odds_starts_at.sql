-- 0092_boosted_odds_starts_at.sql
--
-- Scheduled ZillaBoost rules: configure a boost now, have it activate
-- later. `starts_at IS NULL` means "live immediately", which is what
-- every existing row means, so no backfill is needed.
--
-- A rule is DELIVERABLE only inside its window:
--     (starts_at IS NULL OR starts_at <= now())
--     AND (ends_at IS NULL OR ends_at > now())
--
-- Every reader must apply BOTH halves. The four that matter:
--   - loadBoostRulesForMatch / loadBoostRulesForMatches (pricing)
--   - validateCustomBoostForBet (placement re-validation)
--   - GET /catalog/zillaboost-banners (promo surfaces)
-- A reader that checks only ends_at would price and PAY OUT a boost the
-- operator scheduled for next week.
--
-- Deliberately NOT gated: the graphics-banner job queue. Generating the
-- artwork ahead of the start time is the whole point of scheduling —
-- the image should be ready and waiting when the boost goes live.
--
-- CHECK enforces a sane window rather than trusting the admin route
-- alone; a zero-length or inverted window is always a bug.

BEGIN;

ALTER TABLE boosted_odds_config
  ADD COLUMN starts_at timestamptz;

ALTER TABLE boosted_odds_config
  ADD CONSTRAINT boosted_odds_window_order
    CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at);

-- Partial index over the scheduled slice: the admin overview and any
-- future "what's queued to go live" view scan exactly these rows, and
-- they're a small minority of the table.
CREATE INDEX boosted_odds_starts_at_idx
  ON boosted_odds_config (starts_at)
  WHERE starts_at IS NOT NULL;

COMMIT;
