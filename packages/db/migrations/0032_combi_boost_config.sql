-- Combi Boost configuration. Single-row table (key = "default") that
-- stores the four payout-multiplier tiers, the per-leg odds floor, and a
-- master enable flag. Mutated only via /admin/combi-boost-config; every
-- mutation writes an admin_audit_log row.
--
-- Why a single-row table instead of bet_product_config: combi boost
-- isn't a discrete bet-product like tiple/tippot — it's a promo on
-- existing combos. Merging it into bet_product_config would inflate
-- the row's column set just for one product's needs. Keeping it
-- separate also makes the JSON shape served to /catalog easier to
-- evolve.
--
-- Tier ordering invariant: t1 < t2 < t3 < t4 on minLegs and on
-- multiplier. CHECKs enforce this so a misconfigured row can't go in.

CREATE TABLE IF NOT EXISTS combi_boost_config (
  id              text PRIMARY KEY DEFAULT 'default',
  enabled         boolean NOT NULL DEFAULT true,
  -- decimal odds floor, e.g. 1.5000. Legs strictly below this don't
  -- count toward the leg-tier threshold. Stored at NUMERIC(5,4) to
  -- match the catalog's NUMERIC(10,4) odds precision.
  min_odds        numeric(5, 4) NOT NULL DEFAULT 1.5000,
  -- 4 tiers, in order. minLegs is strictly increasing; multiplier is
  -- strictly increasing.
  tier1_min_legs  smallint      NOT NULL DEFAULT 2,
  tier1_multiplier numeric(5, 4) NOT NULL DEFAULT 1.0300,
  tier2_min_legs  smallint      NOT NULL DEFAULT 4,
  tier2_multiplier numeric(5, 4) NOT NULL DEFAULT 1.0500,
  tier3_min_legs  smallint      NOT NULL DEFAULT 6,
  tier3_multiplier numeric(5, 4) NOT NULL DEFAULT 1.0800,
  tier4_min_legs  smallint      NOT NULL DEFAULT 8,
  tier4_multiplier numeric(5, 4) NOT NULL DEFAULT 1.1200,
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT combi_boost_config_singleton CHECK (id = 'default'),
  CONSTRAINT combi_boost_config_min_odds_range CHECK (min_odds >= 1.0001 AND min_odds <= 10),
  CONSTRAINT combi_boost_config_tier_legs_order CHECK (
    tier1_min_legs >= 2
    AND tier2_min_legs >  tier1_min_legs
    AND tier3_min_legs >  tier2_min_legs
    AND tier4_min_legs >  tier3_min_legs
    AND tier4_min_legs <= 30
  ),
  CONSTRAINT combi_boost_config_multiplier_order CHECK (
    tier1_multiplier >  1.0
    AND tier2_multiplier > tier1_multiplier
    AND tier3_multiplier > tier2_multiplier
    AND tier4_multiplier > tier3_multiplier
    AND tier4_multiplier <= 5.0
  )
);

-- Seed the default row so /catalog/combi-boost-config can return a
-- 200 from day one. Admins overwrite values via PUT; the singleton
-- constraint blocks INSERT of a second row.
INSERT INTO combi_boost_config (id) VALUES ('default')
  ON CONFLICT (id) DO NOTHING;
