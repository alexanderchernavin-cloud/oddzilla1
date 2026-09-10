-- The competition's period format, per game.
--
-- The storefront shows spin times as a countdown inside the period, which
-- needs to know how long a period IS. That was a constant (600 s — FIBA's
-- 4 x 10), correct for every competition SlotZilla carries today and wrong
-- by two minutes a quarter for the NBA's 4 x 12. A wrong constant here is
-- the quiet kind of wrong: the quarter label comes from the feed and stays
-- right, so nothing looks broken while every countdown is off.
--
-- Sportradar states it per match — `periodlength`, `overtimelength` and
-- `numberofperiods` sit on the match block of the timeline document the
-- service already fetches — so this is read rather than assumed. Verified
-- against the live feed 2026-09-10: a FIBA World Cup fixture reports
-- 10 / 5 / 4.
--
-- NULL means the feed has not said. The client falls back to FIBA and the
-- column stays NULL rather than being defaulted, so "we know it is 10" and
-- "we assumed 10" remain distinguishable — the second is the one worth
-- finding if a countdown is ever reported wrong.

SET LOCAL lock_timeout = '5s';

ALTER TABLE slotzilla_games
  ADD COLUMN IF NOT EXISTS period_seconds    integer,
  ADD COLUMN IF NOT EXISTS overtime_seconds  integer,
  ADD COLUMN IF NOT EXISTS regulation_periods smallint;

-- Seconds, not the feed's minutes: every other duration in this schema is
-- in seconds, and one column in different units is how unit bugs start.
COMMENT ON COLUMN slotzilla_games.period_seconds IS
  'Length of a regulation period in SECONDS, from Sportradar. NULL = not stated.';

ALTER TABLE slotzilla_games
  ADD CONSTRAINT slotzilla_games_period_format_sane
  CHECK (
    (period_seconds IS NULL OR (period_seconds BETWEEN 60 AND 3600))
    AND (overtime_seconds IS NULL OR (overtime_seconds BETWEEN 60 AND 3600))
    AND (regulation_periods IS NULL OR (regulation_periods BETWEEN 1 AND 10))
  );
