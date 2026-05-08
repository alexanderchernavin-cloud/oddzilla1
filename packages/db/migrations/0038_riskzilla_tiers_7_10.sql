-- 0038_riskzilla_tiers_7_10.sql
--
-- Seed riskzilla_settings rows for tiers 7-10. Migration 0037 only
-- seeded 0-6, but Oddin actually uses risk_tier values up to 10 (and
-- the column allows up to 32 for headroom). Without these rows the
-- engine's tierFor() falls back to tier 0's default for any tournament
-- tagged 7-10, masking what should be much tighter limits.
--
-- The schedule continues the pattern from migration 0037 (roughly
-- halving the match_liability per tier as the tier number grows /
-- the tournament gets less liquid). Admins tune via /admin/riskzilla/
-- settings; these are just safer-than-tier-0 starting points.

INSERT INTO riskzilla_settings (
  tier, match_liability_micro, min_bet_micro, max_payout_micro, bet_factor
) VALUES
  -- Tier 7: small regional leagues. Half of tier 6.
  (7,  500000000, 100000, 250000000, 0.1000),
  -- Tier 8: amateur / qualifiers.
  (8,  250000000, 100000, 100000000, 0.1000),
  -- Tier 9: very low coverage, late-bound odds.
  (9,  100000000, 100000,  50000000, 0.1000),
  -- Tier 10: lowest-trust events (Oddin's max in our current feed).
  (10,  50000000, 100000,  25000000, 0.1000)
ON CONFLICT (tier) DO NOTHING;
