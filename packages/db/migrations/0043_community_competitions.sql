-- 0043_community_competitions.sql
--
-- Phase 11 — Community Competitions (PRD: Operator Dashboard - Competitions
-- V1 + competition-v2 bettor experience).
--
-- A competition is an operator-curated prediction game over a set of
-- matches. Bettors join, predict scores (or tip 1X2 for tipping-type
-- comps), and earn points per the scoring rules. Free entry only in
-- V1 (PRD: "Free competitions only"); the entry-free rule is enforced
-- at the rules-catalog level via locked=true rather than a top-level
-- paid_disabled flag, so the schema doesn't foreclose paid V2.
--
-- Why a separate competition_matches table (not a JSONB array on
-- competitions)?
--   • Settlement (Go) needs to UPDATE per-match scores + status
--     atomically without rewriting the whole competition row.
--   • The matches tab on the bettor surface paginates and filters by
--     status (upcoming / live / done) — JSONB queries are an order of
--     magnitude slower for that read pattern.
--   • One competition match optionally references the catalog `matches`
--     table; when NULL, the competition is curated from manual rows
--     (V1 admin entry) rather than the live odds feed. We allow both
--     paths from day one to unblock seed comps for demo.
--
-- Why competition_participants as its own table (not derived from
-- predictions)?
--   • Leaderboard reads are the hot path — we need to ORDER BY points
--     across thousands of participants. Aggregating from predictions
--     on every read multiplies cost; the denormalised counter pattern
--     (analyses.thumbs_up_count, community_tickets.score) is the house
--     standard. Settlement (Go) is the authoritative writer.
--   • A user can join a competition without making any predictions
--     yet (the JoinPanel→leaderboard transition needs to render their
--     row at 0 points).
--
-- Why predictions store the predicted score even for tipping comps?
--   • Some tipping rules combine the 1X2 tip with a nearest-score
--     tiebreaker (PRD: tiebreaker-earliest, tiebreaker-correct-score).
--     Carrying both fields lets settlement evaluate every tiebreaker
--     rule from one row. NULL `tip` distinguishes prediction-only
--     comps from tipping comps; a CHECK enforces the right-shape per
--     competition_type.
--
-- Why an explicit competition_rules table rather than JSONB on
-- competitions?
--   • The Notion spec mandates a CompetitionRule[] = { ruleId, value? }
--     shape "aligned with Colosseum's competition_rules schema". A
--     relational table preserves that alignment and lets settlement
--     join rules into its scoring transaction without parsing JSON.
--   • Each rule has a category (scoring / entry / tiebreaker / timing
--     / eligibility / prize); a well-known rule_id catalog identifier
--     keeps the column count flat without a self-referential rule
--     definitions table. The catalog itself lives in TS land
--     (packages/types/src/competitions.ts) because it's product-tuned
--     copy, not data; the BE only needs the FK identifier + value.
--
-- Settlement integration (Phase 11.5):
--   The Go settlement service joins competition_predictions to the
--   settling match via competition_matches.match_id, evaluates the
--   competition's scoring rules, writes points_awarded on each
--   prediction, and bumps the participant's denormalised aggregates.
--   See services/settlement/competitions.go.

BEGIN;

-- 1. Status enum. Notion spec uses 5 states; we adopt them verbatim.
-- 'draft' = operator save-as-draft (not visible to bettors).
-- 'scheduled' = operator scheduled but launch_at hasn't fired yet
-- (driven by a launch cron worker, not the bettor read path).
-- 'upcoming' = visible, accepting joins + predictions.
-- 'live' = first match has kicked off; new predictions blocked per
-- timing-lock-kickoff rule.
-- 'ended' = stop_show_at has passed; archived view only.
CREATE TYPE competition_status AS ENUM (
    'draft',
    'scheduled',
    'upcoming',
    'live',
    'ended'
);

-- 2. Competition type. Drives the prediction UI shape:
--   • 'prediction' — score predictor (predicted_score_a/b required)
--   • 'tipping'    — 1X2 tip (predicted_score still optional for
--                    tiebreaker), `tip` required
--   • 'challenge'  — generic; type-specific fields enforced by rules
CREATE TYPE competition_type AS ENUM (
    'prediction',
    'tipping',
    'challenge'
);

-- 3. Per-match status inside a competition. Decoupled from the global
-- match_status enum because some competitions are curated manually
-- (no FK to matches) — the operator drives this status directly.
-- 'suspended' / 'cancelled' from competition-v2 are display-only flags
-- exposed via boolean columns rather than enum values; they don't
-- affect scoring eligibility (cancelled matches simply void
-- predictions rather than score them).
CREATE TYPE competition_match_status AS ENUM (
    'upcoming',
    'live',
    'done'
);

-- 4. Competitions root table.
CREATE TABLE competitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    type        competition_type   NOT NULL,
    status      competition_status NOT NULL DEFAULT 'draft',

    -- Sport scope. NULL = multi-sport (rare; PRD says single-sport in
    -- V1 but we don't NOT NULL it because the admin "Start from
    -- Scratch" template lets the operator skip it pre-publish).
    sport_id INTEGER REFERENCES sports(id),
    -- League is free text for V1. We don't FK to tournaments because
    -- some operator-curated leagues won't exist in the catalog
    -- (cross-tournament weekly predictors, manual cups). Tightening
    -- this to a tournaments FK is a V2 concern.
    league TEXT,

    -- Schedule timestamps mirror CompetitionTimestamps verbatim from
    -- competition-v2/src/types.ts. Keep them as four columns rather
    -- than a JSONB blob so DB CHECK constraints can enforce ordering.
    launch_at       TIMESTAMPTZ NOT NULL,
    bet_close_at    TIMESTAMPTZ NOT NULL,
    match_start_at  TIMESTAMPTZ NOT NULL,
    stop_show_at    TIMESTAMPTZ NOT NULL,

    -- Visual assets. Banner is the hero header; thumbnail is the list
    -- row. Both URLs are TEXT — uploads land in S3 (admin uploader) or
    -- reference Oddin assets (seed comps).
    banner_url    TEXT,
    thumbnail_url TEXT,

    -- Featured promotes a comp into the FeaturedHero rotator on the
    -- bettor home. Multiple featured comps are allowed; the rotator
    -- cycles them.
    featured BOOLEAN NOT NULL DEFAULT FALSE,

    -- Markets array — display chips on the detail page. e.g.
    -- ['1X2', 'correct-score']. TEXT[] rather than a referenced enum
    -- because the operator types these and we don't gate on a
    -- catalog in V1.
    markets TEXT[] NOT NULL DEFAULT '{}',

    -- Denormalised counters. Bumped at API write time (join /
    -- prediction). See community_tickets.inspiration_count for the
    -- precision-vs-simplicity argument.
    participant_count INTEGER NOT NULL DEFAULT 0,
    match_count       INTEGER NOT NULL DEFAULT 0,

    -- Audit. created_by NULL on seed comps (no operator).
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (char_length(title) BETWEEN 1 AND 200),
    CHECK (char_length(description) <= 2000),
    CHECK (participant_count >= 0),
    CHECK (match_count >= 0),
    -- Schedule ordering: a comp must close betting at or before
    -- match-start, and stop showing at or after match-start. launch_at
    -- comes first but we let admins schedule launches in the past
    -- (e.g. seed comps inserted retroactively) — no constraint there.
    CHECK (bet_close_at <= match_start_at),
    CHECK (match_start_at <= stop_show_at)
);

-- Bettor list filtered by status + ordered by launch_at. The PRD
-- shows a status-tab strip (All / Live / Upcoming / Draft / Ended);
-- this index covers every tab read.
CREATE INDEX competitions_status_launch_idx
    ON competitions (status, launch_at DESC);

-- Featured rotator on the bettor home. Partial because most comps
-- aren't featured.
CREATE INDEX competitions_featured_idx
    ON competitions (launch_at DESC)
    WHERE featured = TRUE AND status IN ('upcoming', 'live');

-- Operator's own list (admin /competitions). Sorted by created_at so
-- the operator's most recent drafts surface first.
CREATE INDEX competitions_created_by_idx
    ON competitions (created_by, created_at DESC)
    WHERE created_by IS NOT NULL;

-- 5. Rules catalog assignments. rule_id is the well-known catalog
-- identifier (e.g. 'scoring-correct-result', 'entry-free') from
-- packages/types/src/competitions.ts. value carries the configurable
-- payload as text (point values, integer caps, ISO durations) so the
-- table is value-shape-agnostic; the catalog tells consumers how to
-- parse each rule's value.
CREATE TABLE competition_rules (
    competition_id UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    rule_id        TEXT NOT NULL,
    value          TEXT,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (competition_id, rule_id)
);

-- Settlement reads scoring rules in bulk; the rule_id LIKE 'scoring-%'
-- lookups dominate that path.
CREATE INDEX competition_rules_competition_idx
    ON competition_rules (competition_id, rule_id);

-- 6. Competition matches.
CREATE TABLE competition_matches (
    id              BIGSERIAL PRIMARY KEY,
    competition_id  UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    -- Optional FK to the catalog. NULL = manual match (admin typed
    -- team names directly, no live odds wiring). When non-NULL,
    -- settlement can pull the final score from matches.score_* via
    -- the existing settle pipeline; when NULL, the operator enters
    -- scores in the admin UI and settlement reads them from this row.
    match_id        BIGINT REFERENCES matches(id) ON DELETE SET NULL,
    -- Denormalised match facing — keeps the matches tab read cheap
    -- and renders correctly even when match_id is NULL.
    team_a          TEXT NOT NULL,
    team_b          TEXT NOT NULL,
    league          TEXT NOT NULL DEFAULT '',
    kickoff_at      TIMESTAMPTZ NOT NULL,
    status          competition_match_status NOT NULL DEFAULT 'upcoming',
    score_a         INTEGER,
    score_b         INTEGER,
    -- Display-only flags from competition-v2 prototype. The operator
    -- dashboard doesn't expose these in V1 (PRD calls them out as a
    -- scope gap); we carry the columns so the UI is faithful and a
    -- future admin field can flip them without a migration.
    suspended       BOOLEAN NOT NULL DEFAULT FALSE,
    cancelled       BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (score_a IS NULL OR score_a >= 0),
    CHECK (score_b IS NULL OR score_b >= 0),
    -- Both scores set together or neither — half-set rows would
    -- mislead settlement.
    CHECK ((score_a IS NULL) = (score_b IS NULL))
);

-- Same catalog match cannot appear twice in one competition. NULL
-- match_id rows (manual entries) are exempt — the partial unique
-- index handles that.
CREATE UNIQUE INDEX competition_matches_unique_idx
    ON competition_matches (competition_id, match_id)
    WHERE match_id IS NOT NULL;

-- Matches tab read pattern: list a competition's matches by kickoff.
CREATE INDEX competition_matches_kickoff_idx
    ON competition_matches (competition_id, kickoff_at);

-- Settlement lookup: when a catalog match settles, find every
-- competition that includes it.
CREATE INDEX competition_matches_match_id_idx
    ON competition_matches (match_id)
    WHERE match_id IS NOT NULL;

-- 7. Competition participants. PK on (competition_id, user_id) gives
-- both idempotency for join (ON CONFLICT DO NOTHING) and a natural
-- read path for "is this user in this comp".
CREATE TABLE competition_participants (
    competition_id    UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Aggregate stats. Authoritative writer is services/settlement
    -- (Go); the API only ever increments via UPDATE inside the
    -- participant join path (which sets these to 0, the default).
    points            INTEGER NOT NULL DEFAULT 0,
    correct_count     INTEGER NOT NULL DEFAULT 0,
    -- Denominator for win rate. Unsettled predictions don't count;
    -- settlement bumps total_settled when it writes points_awarded.
    total_settled     INTEGER NOT NULL DEFAULT 0,
    -- Current consecutive correct count. Resets to 0 on a
    -- non-correct settlement; bumps to streak+1 on a correct one.
    streak            INTEGER NOT NULL DEFAULT 0,
    -- Best streak ever — drives the profile/leaderboard "best" badge.
    longest_streak    INTEGER NOT NULL DEFAULT 0,
    last_settled_at   TIMESTAMPTZ,

    PRIMARY KEY (competition_id, user_id),
    CHECK (points         >= 0),
    CHECK (correct_count  >= 0),
    CHECK (total_settled  >= 0),
    CHECK (streak         >= 0),
    CHECK (longest_streak >= 0),
    CHECK (correct_count <= total_settled)
);

-- Leaderboard read. Compound index ordered by points DESC, then by
-- longest_streak DESC as a deterministic tiebreaker (matches the
-- PRD's tiebreaker-earliest fallback when nothing else applies).
CREATE INDEX competition_participants_leaderboard_idx
    ON competition_participants (competition_id, points DESC, longest_streak DESC);

-- "My competitions" read on the bettor home (MyCompetitionsStrip).
CREATE INDEX competition_participants_user_idx
    ON competition_participants (user_id, joined_at DESC);

-- 8. Predictions. UNIQUE (competition_match_id, user_id) is the
-- one-prediction-per-user-per-match invariant; double-POST returns
-- 409 from the API layer.
CREATE TABLE competition_predictions (
    id                    BIGSERIAL PRIMARY KEY,
    competition_id        UUID   NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    competition_match_id  BIGINT NOT NULL REFERENCES competition_matches(id) ON DELETE CASCADE,
    user_id               UUID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    predicted_score_a     INTEGER NOT NULL,
    predicted_score_b     INTEGER NOT NULL,
    -- '1' | 'X' | '2' for tipping comps; NULL for prediction-only
    -- comps. The CHECK constraint pins the shape; the API enforces
    -- per-competition_type that the right shape is sent (predictions
    -- API rejects a tipping payload missing `tip`).
    tip                   CHAR(1),
    placed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Settlement output. NULL until the underlying competition_match
    -- settles. points_awarded is the per-match score per the
    -- competition's scoring rules; the participant's aggregate
    -- `points` column is the SUM across their settled predictions.
    points_awarded        INTEGER,
    -- 'correct' / 'partial' / 'wrong' / 'void' — derived from
    -- per-rule scoring. We store TEXT rather than another enum
    -- because the rule catalog can introduce new outcome labels
    -- (e.g. 'exact-score') without a migration; settlement is the
    -- only writer.
    outcome               TEXT,
    settled_at            TIMESTAMPTZ,

    CHECK (predicted_score_a >= 0),
    CHECK (predicted_score_b >= 0),
    CHECK (tip IS NULL OR tip IN ('1', 'X', '2')),
    CHECK (points_awarded IS NULL OR points_awarded >= 0)
);

-- One prediction per (match, user). UNIQUE not PRIMARY KEY because
-- the BIGSERIAL id is the natural row identifier for inserts.
CREATE UNIQUE INDEX competition_predictions_unique_idx
    ON competition_predictions (competition_match_id, user_id);

-- "Your picks" read on the detail page — fetches every prediction a
-- user has made in this comp.
CREATE INDEX competition_predictions_user_idx
    ON competition_predictions (competition_id, user_id);

-- Settlement read: when a competition_match settles, find every
-- prediction on it.
CREATE INDEX competition_predictions_settle_idx
    ON competition_predictions (competition_match_id)
    WHERE settled_at IS NULL;

COMMIT;
