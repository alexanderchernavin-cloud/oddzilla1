-- Add Oddin's risk_tier to tournaments so the sidebar (and any future
-- consumer) can surface tournaments in the order the user expects —
-- higher risk_tier first. Backfilled off-line by running
-- `feed-ingester --backfill-tournament-metadata`; new tournaments get
-- their risk_tier populated automatically on auto-mapping and on
-- every fixture_change refresh.

ALTER TABLE tournaments
  ADD COLUMN risk_tier SMALLINT;

CREATE INDEX tournaments_risk_tier_idx
  ON tournaments (risk_tier DESC NULLS LAST)
  WHERE active = TRUE;
