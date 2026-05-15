-- 0053_accept_odds_changes.sql
--
-- Bettor opt-in for the live-bet acceptance delay (migration 0052). During
-- the window between placement and not_before_ts, the bet-delay worker
-- re-checks each leg against the latest published_odds + market.status +
-- outcome.active. With `accept_odds_changes = FALSE` (the default and the
-- behaviour pre-0053), any drift beyond tolerance rejects the ticket. With
-- `accept_odds_changes = TRUE`, the worker re-prices the ticket at the
-- current odds instead — single + combo only, since tiple / tippot are
-- priced off probabilities (not the published price) at placement and
-- betbuilder anchors on the OBB session id.
--
-- Suspended / inactive checks still reject regardless of the flag —
-- "accept ANY odds change" doesn't mean "accept a market that's no longer
-- bettable".

BEGIN;

ALTER TABLE tickets
  ADD COLUMN accept_odds_changes boolean NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN tickets.accept_odds_changes IS
  'Bettor opt-in: during the live-bet acceptance delay window, if true and the per-leg published odds have drifted beyond tolerance, the bet-delay worker accepts the bet at the current odds (updating ticket_selections.odds_at_placement + tickets.potential_payout_micro in the same tx) instead of rejecting with odds_drift_exceeded. Suspended / inactive / no-current-price checks still reject regardless. Single + combo only — flag is ignored for tiple / tippot / betbuilder.';

COMMIT;
