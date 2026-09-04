-- 0097_bet_intent_velocity
--
-- Operator knobs for the anti-automation controls on bet placement, plus
-- the per-ticket confirm-time measurement they produce.
--
-- Background (2026-09-03): POST /bets is an ordinary JSON endpoint and
-- nothing distinguishes the slip from a script. Making placement
-- "mouse-only" is not achievable on the open web, so the goal is to make
-- automation gain nothing and get noticed:
--
--   * Placement intent token. The slip asks POST /bets/intent for a
--     short-lived HMAC token bound to (user, selection set, issued-at);
--     POST /bets requires it. This forces every placement through the
--     same quote step the slip uses and gives the server a trustworthy
--     quote timestamp. Stateless (HMAC over JWT_SECRET-derived key);
--     single-use is enforced best-effort via a Redis nonce.
--   * Minimum human time. A placement confirmed less than `min_human_ms`
--     after its quote is rejected (`intent_too_fast`). A bot can wait,
--     but waiting is exactly what removes the latency-arbitrage edge.
--   * Per-account velocity. Placements per minute and distinct matches
--     per minute, scaled by the bettor's RiskZilla risk score
--     (cap = max(1, round(base x RS))). Rejections log as
--     `rejected_velocity` (enum value added in 0096).
--   * Behaviour scoring thresholds (tables in 0098) live here too so the
--     whole "bot controls" surface is one admin page.
--
-- Singleton row (id = 1). Read on every placement and intent issue —
-- memoised in-process for a few seconds by the api; the admin PUT
-- invalidates the memo. Postgres, not Redis: operator state must not
-- live in a cache (see 0095 for what happens when it does).

CREATE TABLE IF NOT EXISTS riskzilla_bot_controls (
  id                         SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Require a valid placement intent token on POST /bets. Emergency
  -- off-switch: a client bug that stops the slip from quoting would
  -- otherwise lock every bettor out.
  intent_required            BOOLEAN NOT NULL DEFAULT TRUE,
  intent_ttl_seconds         INTEGER NOT NULL DEFAULT 120
                             CHECK (intent_ttl_seconds BETWEEN 15 AND 900),
  -- Minimum quote -> place gap. 0 disables the check.
  min_human_ms               INTEGER NOT NULL DEFAULT 600
                             CHECK (min_human_ms BETWEEN 0 AND 10000),
  velocity_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  -- Base caps at risk_score 1.000; effective cap = max(1, round(base x RS)).
  max_bets_per_minute        INTEGER NOT NULL DEFAULT 12
                             CHECK (max_bets_per_minute BETWEEN 1 AND 1000),
  max_matches_per_minute     INTEGER NOT NULL DEFAULT 10
                             CHECK (max_matches_per_minute BETWEEN 1 AND 1000),
  -- Behaviour scoring (0098): a bettor whose combined score reaches the
  -- threshold across at least `behaviour_min_sessions` scored sessions
  -- raises an automation alert in RiskZilla.
  behaviour_alert_threshold  NUMERIC(4,3) NOT NULL DEFAULT 0.700
                             CHECK (behaviour_alert_threshold > 0 AND behaviour_alert_threshold <= 1),
  behaviour_min_sessions     INTEGER NOT NULL DEFAULT 2
                             CHECK (behaviour_min_sessions BETWEEN 1 AND 100),
  updated_by                 UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO riskzilla_bot_controls (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE riskzilla_bot_controls IS
  'Singleton: anti-automation knobs for bet placement (intent token, minimum human confirm time, per-account velocity caps, behaviour-score alert threshold).';

-- Milliseconds between the placement intent being issued and POST /bets
-- landing. NULL for tickets placed before this migration, or while
-- intent_required is off and the client sent no token. Humans spread
-- widely; automation clusters just above min_human_ms. Feeds the
-- per-bettor behaviour rollup (0098) and the RiskZilla bettor profile.
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS quote_to_place_ms INTEGER
  CHECK (quote_to_place_ms IS NULL OR quote_to_place_ms >= 0);

COMMENT ON COLUMN tickets.quote_to_place_ms IS
  'ms from placement-intent issue to POST /bets; NULL when no intent token accompanied the placement.';
