-- 0046_community_projection_tables.sql
--
-- Audit fixes H1 / H3 / M6 / M2 — denormalised projection tables that
-- replace four recompute-per-read aggregations on the Community
-- surface. Every table here is a read-projection: the source of truth
-- still lives on `analyses`, `community_tickets`, and
-- `competition_predictions`. The projection is maintained by the same
-- write paths that touch those tables, NEVER by a cron.
--
-- ─── community_author_stats ────────────────────────────────────────────
--
-- One row per author. Replaces two correlated subqueries on the
-- /community/analyses feed (per-row author win rate + the top_authors
-- sort that ran the same subquery twice per row) and one SUM over
-- community_tickets in loadAuthorStats (inspired turnover).
--
-- Writers:
--   • Analyses settlement path — when an analysis flips to a settled
--     outcome, bump `settled_analyses` (+1) and `won_analyses`
--     (+1 iff outcome='won'), then recompute `win_rate_pct`.
--   • writeCommunityProjection (services/api/.../community/projection.ts)
--     — when a row with copied_from_publisher_id is INSERTED into
--     community_tickets, bump `inspired_turnover_micro` by stake_micro.
--     INSERT-only: the projection's upsert path runs on cashout AND on
--     Go settlement, so the "credit once per ticket" invariant comes
--     from xmax=0 in RETURNING (see projection.ts).
--
-- Why nullable win_rate_pct: the PRD floor is 3 settled analyses
-- before a win rate appears. Storing NULL preserves that semantic
-- without a CASE on every read.
--
-- ─── community_user_stats ──────────────────────────────────────────────
--
-- One row per (user_id, currency). Replaces the per-load SUM/COUNT
-- over community_tickets in loadProfileStats (routes.ts).
--
-- Writer: the ticket-settlement path that flips status to
-- settled/cashed_out. The cashout TS path lands the update inline;
-- the Go settlement service (services/settlement/) will mirror it in
-- PR9 of this audit series — a TODO in cashout/service.ts marks the
-- Go-side gap so the two paths converge.
--
-- Why per-currency: ROI and win-rate semantics only make sense within
-- one currency; mixing crypto + fiat under one aggregate would be
-- misleading. The PK (user_id, currency) matches the read-side
-- filter exactly.
--
-- ─── competition_participants.recent_outcomes ──────────────────────────
--
-- TEXT[] capped at 5 elements. Replaces the 50 correlated subqueries
-- on the competition leaderboard read (one per top-50 participant)
-- with a direct column read.
--
-- Writer: scoreMatchPredictions in services/api/.../admin/competitions.ts
-- — when a prediction settles, prepend the new outcome and truncate
-- to the 5 most recent. Idempotent under the prediction's
-- settled_at IS NULL guard.
--
-- ─── Backfill ──────────────────────────────────────────────────────────
--
-- INTENTIONALLY NOT IN THIS MIGRATION. Backfilling each of these
-- aggregates on a large production table from inside an ALTER+CREATE
-- migration would (a) hold an exclusive lock far longer than the
-- table additions need, and (b) make rollback significantly riskier.
-- The backfill SQL lives in scripts/backfills/0046_community_stats.sql
-- and is run by ops post-deploy. The read paths handle the missing-
-- row case (LEFT JOIN → NULL → null in the response shape) so the
-- gap between migration and backfill is non-breaking.

BEGIN;

-- 1. community_author_stats. One row per author, lazily inserted on
--    first settlement of an analysis or first inspired-copy event.
CREATE TABLE community_author_stats (
    user_id                  UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settled_analyses         INTEGER NOT NULL DEFAULT 0,
    won_analyses             INTEGER NOT NULL DEFAULT 0,
    -- NULL until the author has at least 3 settled analyses. The
    -- writer recomputes this column on every analyses-settlement
    -- bump; the read path joins and surfaces NULL straight through.
    win_rate_pct             INTEGER,
    inspired_turnover_micro  BIGINT NOT NULL DEFAULT 0,
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT community_author_stats_settled_nonneg CHECK (settled_analyses >= 0),
    CONSTRAINT community_author_stats_won_nonneg CHECK (won_analyses >= 0),
    CONSTRAINT community_author_stats_won_le_settled CHECK (won_analyses <= settled_analyses),
    CONSTRAINT community_author_stats_win_rate_range CHECK (
        win_rate_pct IS NULL OR (win_rate_pct >= 0 AND win_rate_pct <= 100)
    ),
    CONSTRAINT community_author_stats_inspired_nonneg CHECK (inspired_turnover_micro >= 0)
);

-- The top_authors sort scans this table directly. Compound index
-- ordered by win_rate_pct DESC NULLS LAST, settled_analyses DESC so
-- ties break on volume. The author feed query LEFT JOINs by user_id
-- (PK lookup, no index needed beyond the PK).
CREATE INDEX community_author_stats_top_idx
    ON community_author_stats (win_rate_pct DESC NULLS LAST, settled_analyses DESC);

-- 2. community_user_stats. One row per (user_id, currency). Lazily
--    inserted on first ticket settlement for that pairing.
CREATE TABLE community_user_stats (
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    currency           TEXT NOT NULL,
    settled_count      INTEGER NOT NULL DEFAULT 0,
    wins_count         INTEGER NOT NULL DEFAULT 0,
    total_stake_micro  BIGINT NOT NULL DEFAULT 0,
    total_payout_micro BIGINT NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, currency),
    CONSTRAINT community_user_stats_settled_nonneg CHECK (settled_count >= 0),
    CONSTRAINT community_user_stats_wins_nonneg CHECK (wins_count >= 0),
    CONSTRAINT community_user_stats_wins_le_settled CHECK (wins_count <= settled_count),
    CONSTRAINT community_user_stats_stake_nonneg CHECK (total_stake_micro >= 0),
    CONSTRAINT community_user_stats_payout_nonneg CHECK (total_payout_micro >= 0)
);

-- 3. competition_participants.recent_outcomes. Capped at 5 elements
--    by the writer ((ARRAY[new] || old)[1:5]); no DB-side check
--    because Postgres arrays can't express a length constraint
--    without a trigger and the writer is the only path.
ALTER TABLE competition_participants
    ADD COLUMN IF NOT EXISTS recent_outcomes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMIT;
