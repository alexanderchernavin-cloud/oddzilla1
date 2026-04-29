-- 0017_tiple_tippot.sql
--
-- Two new probability-driven bet products that build on top of the
-- probability columns 0015_cashout.sql added to market_outcomes /
-- odds_history / ticket_selections:
--
--   tiple  — wins if at least one leg wins.
--            offered_odds = 1 / (P_at_least_one × (1 + margin_bp/10000))
--            where P_at_least_one = 1 − ∏(1 − pᵢ).
--
--   tippot — payout scaled by # of winning legs.
--            stake is treated as N equal sub-bets, each on "≥k wins".
--            tier_offered_k = (1/N) × 1/P(≥k) / (1 + margin_bp/10000).
--            cumulative multiplier for finishing with j wins:
--              Mⱼ = Σₖ₌₁ⱼ tier_offered_k
--            Mⱼ is strictly increasing in j; expected payout = stake/(1+m).
--
-- This migration extends the bet_type enum, adds a bet_meta JSONB on
-- tickets to freeze the Tippot tier schedule at placement, and creates
-- bet_product_config for the per-product margin + leg-count limits
-- (admin-tunable from /admin/bet-products).

-- ─── bet_meta JSONB on tickets ─────────────────────────────────────────
-- Carries product-specific data. For tippot:
--   {
--     "product": "tippot",
--     "n": 5,
--     "marginBp": 1500,
--     "tiers": [
--       { "k": 1, "pAtLeastK": "0.9375", "multiplier": "0.232" },
--       { "k": 2, "pAtLeastK": "0.6875", "multiplier": "0.549" },
--       …
--     ]
--   }
-- For tiple:
--   { "product": "tiple", "n": 3, "marginBp": 1500, "fairProbability": "0.875" }
-- For single/combo it stays NULL.
ALTER TABLE tickets
  ADD COLUMN bet_meta JSONB;

-- ─── Extend bet_type enum ──────────────────────────────────────────────
-- Postgres 12+ allows ALTER TYPE ADD VALUE inside a transaction as long
-- as the new value isn't referenced in the same transaction. We don't
-- write any tiple/tippot rows here, so this is safe.
ALTER TYPE bet_type ADD VALUE IF NOT EXISTS 'tiple';
ALTER TYPE bet_type ADD VALUE IF NOT EXISTS 'tippot';

-- ─── bet_product_config ────────────────────────────────────────────────
-- Per-product knobs. margin_bp follows the codebase convention:
--   offered = fair / (1 + margin_bp/10000)
-- so 1500 bp ≈ 13% return-to-house (15% overround).
-- min_legs / max_legs gate placement; tippot defaults to 3 because with
-- 2 legs the tier table degenerates to a single row.
CREATE TABLE bet_product_config (
  product_name  TEXT      PRIMARY KEY,
  margin_bp     INTEGER   NOT NULL,
  min_legs      SMALLINT  NOT NULL,
  max_legs      SMALLINT  NOT NULL,
  enabled       BOOLEAN   NOT NULL DEFAULT TRUE,
  updated_by    UUID      REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (margin_bp BETWEEN 0 AND 5000),
  CHECK (min_legs >= 2),
  CHECK (max_legs >= min_legs AND max_legs <= 30),
  CHECK (product_name IN ('tiple', 'tippot'))
);

-- Defaults: 15% margin (1500 bp) on both.
-- Tiple: 2..20 legs (matches existing combo limit).
-- Tippot: 3..12 legs (3 minimum so tiers are non-trivial; 12 cap keeps
-- the Poisson-Binomial DP cheap and avoids absurd tier-12 payouts that
-- would dominate UI).
INSERT INTO bet_product_config (product_name, margin_bp, min_legs, max_legs)
VALUES
  ('tiple',  1500, 2, 20),
  ('tippot', 1500, 3, 12);
