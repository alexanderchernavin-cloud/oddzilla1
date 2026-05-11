-- 0046_community_stats.sql — post-deploy backfill for migration
-- 0046_community_projection_tables.sql.
--
-- Run AFTER the migration has applied and AFTER the new write paths
-- are deployed. The order matters: if you backfill before the writer
-- ships, any settlement that lands between backfill and deploy is
-- silently lost. The writer-first order means the only data the
-- backfill needs to cover is the historical pre-deploy population.
--
-- Run as a normal psql script:
--   psql "$DATABASE_URL" -f scripts/backfills/0046_community_stats.sql
--
-- Each backfill is wrapped in its own transaction so a failure in one
-- doesn't roll back the others. Re-running is safe: every statement is
-- an INSERT … ON CONFLICT DO UPDATE that overwrites with the
-- recomputed value (idempotent for community_*_stats, and the
-- recent_outcomes UPDATE recomputes the slice deterministically).

-- ─── community_author_stats ────────────────────────────────────────────
-- Aggregate every author's settled analyses, recompute win_rate_pct.
-- analyses with outcome IN ('void','cashed_out_void') count toward
-- settled but NOT toward the wins denominator — matches the API rule
-- in loadAuthorStats and the inline subquery the migration replaced.
BEGIN;

INSERT INTO community_author_stats (
    user_id, settled_analyses, won_analyses, win_rate_pct, updated_at
)
SELECT
    a.author_id,
    COUNT(*) FILTER (
        WHERE a.outcome IS NOT NULL
          AND a.outcome IN ('won', 'lost', 'void', 'cashed_out_void')
    )::int                                                    AS settled_analyses,
    COUNT(*) FILTER (WHERE a.outcome = 'won')::int            AS won_analyses,
    CASE
        WHEN COUNT(*) FILTER (
            WHERE a.outcome IS NOT NULL
              AND a.outcome IN ('won', 'lost', 'void', 'cashed_out_void')
        ) >= 3
        THEN ROUND(
            100.0 * COUNT(*) FILTER (WHERE a.outcome = 'won')
                  / NULLIF(COUNT(*) FILTER (WHERE a.outcome IN ('won', 'lost')), 0)
        )::int
        ELSE NULL
    END                                                        AS win_rate_pct,
    now()
  FROM analyses a
 WHERE a.status = 'published'
 GROUP BY a.author_id
ON CONFLICT (user_id) DO UPDATE
   SET settled_analyses = EXCLUDED.settled_analyses,
       won_analyses     = EXCLUDED.won_analyses,
       win_rate_pct     = EXCLUDED.win_rate_pct,
       updated_at       = now();

-- Inspired turnover is independent of analyses-settlement. The
-- aggregate sums stake_micro across community_tickets where the
-- viewer's copy was attributed to a publisher. Ticket status doesn't
-- gate this — once a copy lands, the publisher's "inspired turnover"
-- includes it regardless of how the copy itself settles.
INSERT INTO community_author_stats (user_id, inspired_turnover_micro, updated_at)
SELECT
    ct.copied_from_publisher_id,
    COALESCE(SUM(ct.stake_micro), 0)::bigint,
    now()
  FROM community_tickets ct
 WHERE ct.copied_from_publisher_id IS NOT NULL
 GROUP BY ct.copied_from_publisher_id
ON CONFLICT (user_id) DO UPDATE
   SET inspired_turnover_micro = EXCLUDED.inspired_turnover_micro,
       updated_at               = now();

COMMIT;

-- ─── community_user_stats ──────────────────────────────────────────────
-- Per (user, currency) settlement totals. Matches loadProfileStats:
-- "settled" counts every row in FEED_STATUSES; "wins" counts settled
-- or cashed_out rows where payout > stake.
BEGIN;

INSERT INTO community_user_stats (
    user_id, currency, settled_count, wins_count,
    total_stake_micro, total_payout_micro, updated_at
)
SELECT
    ct.user_id,
    ct.currency,
    COUNT(*)::int                                            AS settled_count,
    COUNT(*) FILTER (
        WHERE ct.status::text IN ('settled', 'cashed_out')
          AND ct.payout_micro > ct.stake_micro
    )::int                                                   AS wins_count,
    COALESCE(SUM(ct.stake_micro), 0)::bigint                 AS total_stake_micro,
    COALESCE(SUM(ct.payout_micro), 0)::bigint                AS total_payout_micro,
    now()
  FROM community_tickets ct
 WHERE ct.status::text IN ('settled', 'cashed_out', 'voided')
 GROUP BY ct.user_id, ct.currency
ON CONFLICT (user_id, currency) DO UPDATE
   SET settled_count      = EXCLUDED.settled_count,
       wins_count         = EXCLUDED.wins_count,
       total_stake_micro  = EXCLUDED.total_stake_micro,
       total_payout_micro = EXCLUDED.total_payout_micro,
       updated_at         = now();

COMMIT;

-- ─── competition_participants.recent_outcomes ──────────────────────────
-- Last 5 settled prediction outcomes per (competition, user), newest
-- first. The (ARRAY[…])[1:5] trick truncates without a window.
BEGIN;

WITH recent AS (
    SELECT
        cp.competition_id,
        cp.user_id,
        ARRAY(
            SELECT pred.outcome
              FROM competition_predictions pred
             WHERE pred.competition_id = cp.competition_id
               AND pred.user_id        = cp.user_id
               AND pred.settled_at     IS NOT NULL
               AND pred.outcome        IS NOT NULL
             ORDER BY pred.settled_at DESC
             LIMIT 5
        ) AS recent_outcomes
      FROM competition_participants cp
)
UPDATE competition_participants cp
   SET recent_outcomes = r.recent_outcomes
  FROM recent r
 WHERE cp.competition_id = r.competition_id
   AND cp.user_id        = r.user_id;

COMMIT;
