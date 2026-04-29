-- 0018_bet_product_per_leg_margin.sql
--
-- Background: Tippot's all-N-wins payout (the cumulative top tier M_N) was
-- coming out HIGHER than the equivalent combo's payout under the previous
-- flat-margin model. That violates the product contract: combo wins only
-- if every leg wins, while Tippot pays partial wins too — so combo must
-- dominate Tippot at the all-wins corner. The reason the math drifted is
-- structural: a combo's overround compounds across legs (each leg's odds
-- already carry the bookmaker margin, multiplied N times), while Tippot's
-- flat margin is applied once. With N=4 the gap was already material; at
-- N=10+ Tippot would routinely beat combo's all-wins multiplier.
--
-- Fix: extend bet_product_config with `margin_bp_per_leg`, so the
-- effective margin used at pricing time is
--
--   effective_margin_bp = margin_bp + margin_bp_per_leg * N
--
-- where N is the number of legs on the slip. This restores the per-leg
-- compounding the combo product gets for free. Defaults:
--
--   tiple : margin_bp=1500, margin_bp_per_leg=0     (unchanged: flat 15%)
--   tippot: margin_bp=0,    margin_bp_per_leg=500   (new: 5% × N)
--
-- Both knobs are independently tunable from /admin/bet-products. Already
-- placed Tippot/Tiple tickets are unaffected — settlement reads the
-- frozen tier schedule from tickets.bet_meta, not from this table.

ALTER TABLE bet_product_config
  ADD COLUMN margin_bp_per_leg INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT bet_product_config_margin_per_leg_range
    CHECK (margin_bp_per_leg BETWEEN 0 AND 5000);

-- Switch tippot from flat 1500 bp to 500 bp per leg. At N=3 the effective
-- (1500 bp) matches the previous flat default exactly; at higher N the
-- per-leg term keeps Tippot's all-wins multiplier strictly below combo.
UPDATE bet_product_config
   SET margin_bp = 0,
       margin_bp_per_leg = 500
 WHERE product_name = 'tippot';
