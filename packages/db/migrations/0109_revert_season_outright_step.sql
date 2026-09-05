-- 0109_revert_season_outright_step
--
-- Undoes a shipped mistake in 0107.
--
-- 0107 stepped "outright" markets three tiers stricter, and its pattern
-- set included `season NN/NN`. That reads like an outright and is not:
-- Fonbet names the CURRENT SEASON OF A LEAGUE that way. Measured on
-- production after the fact:
--
--   England. Premier League. Season 26/27      12 fixtures,   812 markets
--   Italy. Serie A. Season 26/27               16 fixtures, 1 102 markets
--   Spain. Primera Division. Season 26/27      16 fixtures, 1 095 markets
--   Russia. Premier League. Season 26/27       13 fixtures, 1 170 markets
--
-- Those are the leagues themselves. A genuine outright — "Head-to-head in
-- the tournament" — carries 0-2 active markets and no fixtures, which is
-- the signal the pattern should have been checked against. It was
-- validated against NAMES only.
--
-- The cost was commercial rather than dangerous, but real: Serie A's
-- per-match liability budget fell from tier 3 (~10 000 USDC) to tier 6
-- (~1 000), so the book was refusing business on its biggest football
-- markets. It also pushed the Premier League below the Championship in
-- the sidebar's tier ordering, which is how it surfaced.
--
-- This reverses exactly the +3 those rows were given: -3, floored at the
-- tier ZillaAGI plus its safety margin would have produced. The `+3
-- outright` marker in risk_tier_note is what identifies them, so rows
-- 0107 never touched are untouched here, and the marker is rewritten so
-- this migration is not applied twice to the same row.
--
-- The genuine outrights keep their +3. Only the season-named leagues are
-- corrected.

SET LOCAL lock_timeout = '5s';

WITH corrected AS (
  SELECT id, risk_tier, risk_tier_note
    FROM tournaments
   WHERE risk_tier_source = 'zagi'
     AND risk_tier IS NOT NULL
     AND risk_tier_note LIKE '%+3 outright%'
     -- The false-positive shape, and only it.
     AND name ~* 'season[[:space:]]+[0-9]{2}[[:space:]]*/[[:space:]]*[0-9]{2}'
     -- Not an outright: it has fixtures under it.
     AND EXISTS (SELECT 1 FROM matches m WHERE m.tournament_id = tournaments.id)
)
UPDATE tournaments t
   SET risk_tier = GREATEST(1, t.risk_tier - 3),
       risk_tier_note = left(
         replace(corrected.risk_tier_note, '+3 outright', 'outright step reverted by 0109')
           || ' -> T' || GREATEST(1, t.risk_tier - 3)::text,
         500
       )
  FROM corrected
 WHERE corrected.id = t.id;
