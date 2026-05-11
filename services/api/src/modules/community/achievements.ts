// Achievement evaluator. Mirrors the Go implementation in
// services/settlement/internal/store/store.go :: EvaluateAchievements
// — both write the same rows so any settle path (Go settlement, TS
// cashout, admin backfill) drives unlocks without divergence.
//
// Idempotent on the (user_id, achievement_id) composite PK; safe to
// run on every projection write, including replays. Failure is best-
// effort at every call site (a badge bug must never unwind a real
// settlement / cashout).

import { sql } from "drizzle-orm";
import type { CommunityProjectionExecutor } from "./projection.js";

// Same SQL as the Go side. Reads the user's `community_tickets`
// aggregates (post-projection-write) and inserts any newly-earned
// badges. Predicates land in migration 0029_community_achievements.sql.
export async function evaluateAchievements(
  db: CommunityProjectionExecutor,
  ticketIds: readonly string[],
): Promise<number> {
  if (ticketIds.length === 0) return 0;

  const result = await db.execute<Record<string, unknown>>(sql`
WITH targets AS (
  -- Audit SEC-C1: explicit AI seed bettor exclusion. Belt-and-braces
  -- on top of projection.ts skipping the write — if a future caller
  -- ever invokes evaluateAchievements without first running
  -- writeCommunityProjection, AI accounts still can't earn badges.
  -- Mirrors services/settlement/internal/store/store.go ::
  -- EvaluateAchievements.
  SELECT DISTINCT ct.user_id
    FROM community_tickets ct
    JOIN users u ON u.id = ct.user_id AND u.is_ai = false
   WHERE ct.ticket_id = ANY(${ticketIds}::uuid[])
),
stats AS (
  SELECT
    c.user_id,
    COUNT(*) FILTER (
      WHERE c.payout_micro > c.stake_micro
        AND c.status::text IN ('settled', 'cashed_out')
    )::int                                                       AS wins,
    MAX(c.num_legs) FILTER (
      WHERE c.payout_micro > c.stake_micro
        AND c.status::text IN ('settled', 'cashed_out')
    )                                                            AS max_legs_won,
    MAX(c.total_odds) FILTER (
      WHERE c.payout_micro > c.stake_micro
        AND c.status::text IN ('settled', 'cashed_out')
    )                                                            AS max_odds_won,
    MAX(c.payout_micro::float8 / NULLIF(c.stake_micro, 0)::float8) FILTER (
      WHERE c.payout_micro > c.stake_micro
        AND c.status::text IN ('settled', 'cashed_out')
    )                                                            AS max_payout_ratio
    FROM community_tickets c
    JOIN targets t ON t.user_id = c.user_id
   GROUP BY c.user_id
)
INSERT INTO user_achievements (user_id, achievement_id)
SELECT user_id, ach FROM (
  SELECT user_id, 'first_win'   AS ach FROM stats WHERE wins             >= 1
  UNION ALL
  SELECT user_id, 'combo_5'           FROM stats WHERE max_legs_won      >= 5
  UNION ALL
  SELECT user_id, 'odds_20'           FROM stats WHERE max_odds_won      >= 20
  UNION ALL
  SELECT user_id, 'payout_100x'       FROM stats WHERE max_payout_ratio  >= 100
  UNION ALL
  SELECT user_id, 'streak_10'         FROM stats WHERE wins              >= 10
) candidates
ON CONFLICT (user_id, achievement_id) DO NOTHING
RETURNING user_id
`);

  return result.length;
}
