-- 0086_zillaboost_banner.sql
--
-- Promo banner flag for ZillaBoost rules (Custom Boosted Odds,
-- migration 0085). When an operator ticks "Create promo banner" on a
-- rule, the storefront home page surfaces it per scope:
--   market  -> a ZillaFlash-style offer card (market + boosted prices)
--   match   -> a match card (like the match list, no score) showing
--              original + boosted match-winner prices
--   tournament -> a ZillaBoost tournament banner linking to the
--              tournament's match list
--   sport   -> a boost icon next to the sport in the sidebar tree
-- competitor-scope rules have no banner surface (a team isn't a single
-- destination); the flag is accepted but currently unused for them.

BEGIN;

ALTER TABLE boosted_odds_config
  ADD COLUMN banner boolean NOT NULL DEFAULT false;

COMMIT;
