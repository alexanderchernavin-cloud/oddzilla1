-- ZillaTips: persistent state for the per-market "last 5 matches" widget.
--
-- The widget needs two pieces of historical data per market_outcome on a
-- closed match:
--   1. The moment that match transitioned not_started → live, so we can
--      anchor "last prematch tick" queries deterministically.
--   2. The published_odds value for each outcome at that exact moment —
--      i.e. the price a bettor would have seen as the final pre-game
--      number. odds_history is partitioned daily with 90-day retention
--      (migration 0001), so reading it directly is unreliable past the
--      retention window. Storing the snapshot on market_outcomes keeps
--      it indefinitely alongside the outcome row that survives forever.
--
-- Both columns are nullable. live_started_at gets backfilled from
-- scheduled_at for legacy matches in a non-pristine status (the best
-- approximation we have for matches that already kicked off).
-- prematch_odds is backfilled from odds_history for every closed /
-- live / cancelled match still within the 90-day partition window —
-- the latest pre-game tick is exactly the snapshot we want, and the
-- existing (market_id, ts DESC) index makes the per-outcome LIMIT 1
-- lookup cheap. Anything older than 90 days has had its odds_history
-- partitions pruned, so those rows stay NULL and degrade gracefully
-- (the ZillaTips ROI calc excludes legs with no prematch_odds).
--
-- The capture path is feed-ingester's UpdateMatchStatus: when the
-- status guard observes the first not_started → live transition, the
-- statement copies every market_outcomes.published_odds for the match
-- into prematch_odds (idempotent via WHERE prematch_odds IS NULL).

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS live_started_at TIMESTAMPTZ;

UPDATE matches
   SET live_started_at = scheduled_at
 WHERE live_started_at IS NULL
   AND scheduled_at IS NOT NULL
   AND status::text IN ('live', 'closed', 'cancelled');

-- "Last 5 closed matches for team T" is the hot path under each ZillaTips
-- lateral subquery. The legacy matches_home_competitor_idx is on
-- (home_competitor_id) alone, which forces a sort-after-filter of every
-- closed match the team ever played. The two indexes below let Postgres
-- index-scan the top-5 by recency directly (per team, per status), at the
-- cost of a partial index that excludes the not-yet-played rows. Mirror
-- pair for the away role since the OR-with-competitor predicate in the
-- query is BitmapOr'd across both.
CREATE INDEX IF NOT EXISTS matches_home_team_recency_idx
  ON matches (home_competitor_id, status, live_started_at DESC)
  WHERE live_started_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS matches_away_team_recency_idx
  ON matches (away_competitor_id, status, live_started_at DESC)
  WHERE live_started_at IS NOT NULL;

ALTER TABLE market_outcomes
  ADD COLUMN IF NOT EXISTS prematch_odds NUMERIC(10,4);

-- Backfill prematch_odds from odds_history.
--
-- For every market_outcome belonging to a match that's already lived
-- (status IN live / closed / cancelled), pull the most recent
-- odds_history.published_odds whose ts predates the match's
-- live_started_at. Bounded to 90 days of matches because that's the
-- pg_partman retention on odds_history — older partitions are
-- already dropped, so the lateral would find nothing for them anyway.
-- The CROSS JOIN LATERAL implicitly drops outcomes with no matching
-- history row (suspended-only / never-published outcomes), leaving
-- their prematch_odds NULL. ROI math in the API treats NULL as
-- "unrated" — the leg shows but doesn't move the average.
--
-- AND published_odds IS NOT NULL inside the lateral skips suspended
-- ticks (Oddin emits NULL when an outcome is mid-suspension) so we
-- snapshot the last REAL pre-game number, not the moment Oddin pulled
-- the price right before kickoff.
UPDATE market_outcomes mo
   SET prematch_odds = h.published_odds
  FROM markets mk
  JOIN matches m ON m.id = mk.match_id
  CROSS JOIN LATERAL (
    SELECT published_odds
    FROM odds_history
    WHERE market_id = mk.id
      AND outcome_id = mo.outcome_id
      AND ts < m.live_started_at
      AND published_odds IS NOT NULL
    ORDER BY ts DESC
    LIMIT 1
  ) h
 WHERE mo.market_id = mk.id
   AND mo.prematch_odds IS NULL
   AND m.live_started_at IS NOT NULL
   AND m.live_started_at > NOW() - INTERVAL '90 days'
   AND m.status::text IN ('live', 'closed', 'cancelled');
