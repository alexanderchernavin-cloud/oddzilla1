-- 0094_tournament_risk_tier_lock
--
-- Manual risk-tier assignment for tournaments.
--
-- tournaments.risk_tier is normally filled from Oddin's REST
-- /v1/sports/{lang}/tournaments/{urn}/info by feed-ingester's auto-mapper
-- (on tournament creation, on every fixture refresh, and by the offline
-- backfill). The Bifrost backup feed carries no risk tier at all, so when
-- Oddin's meta API is down a brand-new tournament would sit at NULL and
-- RiskZilla would price it off the tier-0 global fallback. The backoffice
-- tournaments page now lets an operator assign the tier by hand; this flag
-- protects that choice from being overwritten by the next automatic
-- refresh. NULL/false rows keep today's behaviour byte-for-byte.

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS risk_tier_locked BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN tournaments.risk_tier_locked IS
  'TRUE when an operator set risk_tier by hand in the backoffice; feed-ingester''s REST refresh and backfill skip locked rows.';
