-- 0016_cashout_acceptance_delay.sql
--
-- Adds a configurable acceptance delay between "user clicks Cash out"
-- and "money moves". Mirrors users.bet_delay_seconds for placement —
-- a short window where the bookmaker can still suspend if the
-- underlying probability moves beyond tolerance.
--
-- Resolution across combo legs: MIN (most restrictive — like the rest
-- of cashout_config). Default 5 seconds globally; admin can set 0 to
-- disable per-scope.

BEGIN;

ALTER TABLE cashout_config
    ADD COLUMN acceptance_delay_seconds INTEGER NOT NULL DEFAULT 5
        CHECK (acceptance_delay_seconds >= 0
           AND acceptance_delay_seconds <= 60);

-- The DEFAULT clause already filled existing rows with 5; nothing
-- else to backfill.

COMMIT;
