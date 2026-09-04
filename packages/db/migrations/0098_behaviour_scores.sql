-- 0098_behaviour_scores
--
-- Behavioural automation scoring on top of the first-party FE analytics
-- (0083). The tracker already persists sampled mouse trails and every
-- click; a periodic api job (every 5 min, Redis NX lock) scores each
-- signed-in session once it has settled and rolls the results up per
-- bettor. Nothing here runs on the placement hot path — POST /bets only
-- ever reads the precomputed per-user row.
--
-- Per-session features (stored as JSON for the admin panel):
--   straightness          mean chord/path ratio over 6-point windows;
--                         interpolated bot moves sit at ~1.0
--   speed_cv              coefficient of variation of point speeds;
--                         humans accelerate and decelerate, bots don't
--   heading_entropy       normalised entropy of heading changes;
--                         straight lines have almost none
--   clicks_without_approach  share of clicks with no mouse sample in the
--                         preceding 1.5 s (page.click() teleports)
--   click_interval_cv     regularity of inter-click gaps
-- A session with too little data (or a touch device with no pointer at
-- all) gets NULL rather than a guess — false positives on trackpads and
-- phones are the known failure mode of this class of signal.

ALTER TABLE analytics_sessions
  ADD COLUMN IF NOT EXISTS behaviour_score NUMERIC(4,3)
    CHECK (behaviour_score IS NULL OR (behaviour_score >= 0 AND behaviour_score <= 1)),
  ADD COLUMN IF NOT EXISTS behaviour_features JSONB,
  ADD COLUMN IF NOT EXISTS behaviour_scored_at TIMESTAMPTZ;

-- The sweeper's work queue: signed-in sessions never scored, or seen
-- again since their last score.
CREATE INDEX IF NOT EXISTS analytics_sessions_behaviour_pending_idx
  ON analytics_sessions (last_seen_at DESC)
  WHERE user_id IS NOT NULL
    AND (behaviour_scored_at IS NULL OR last_seen_at > behaviour_scored_at);

-- Per-bettor rollup. `score` blends the session scores (weighted by
-- sample count, last 30 days) with the confirm-time signal from
-- tickets.quote_to_place_ms (0097). `alert` flips when score >=
-- riskzilla_bot_controls.behaviour_alert_threshold across at least
-- behaviour_min_sessions scored sessions, with 0.1 of hysteresis so it
-- does not flap; a newly raised alert clears any earlier acknowledgement.
CREATE TABLE IF NOT EXISTS bettor_behaviour_scores (
  user_id                UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  score                  NUMERIC(4,3)
                         CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
  max_session_score      NUMERIC(4,3)
                         CHECK (max_session_score IS NULL OR (max_session_score >= 0 AND max_session_score <= 1)),
  sessions_scored        INTEGER NOT NULL DEFAULT 0,
  sessions_insufficient  INTEGER NOT NULL DEFAULT 0,
  -- Aggregated feature summary + confirm-time stats for the profile card.
  features               JSONB NOT NULL DEFAULT '{}'::jsonb,
  alert                  BOOLEAN NOT NULL DEFAULT FALSE,
  alert_since            TIMESTAMPTZ,
  acknowledged_at        TIMESTAMPTZ,
  acknowledged_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  scored_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bettor_behaviour_scores_alert_idx
  ON bettor_behaviour_scores (alert_since DESC)
  WHERE alert = TRUE;

CREATE INDEX IF NOT EXISTS bettor_behaviour_scores_score_idx
  ON bettor_behaviour_scores (score DESC NULLS LAST);

COMMENT ON TABLE bettor_behaviour_scores IS
  'Per-bettor automation likelihood rolled up from analytics_sessions.behaviour_score and tickets.quote_to_place_ms; alert + acknowledgement surface in RiskZilla.';
