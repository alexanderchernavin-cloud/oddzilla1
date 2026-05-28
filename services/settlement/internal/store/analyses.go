// Analyses settlement projection. When a ticket settles (or has its
// settlement reversed) and an analysis is attached to it, the analysis
// inherits the outcome and the author's community_author_stats updates
// in lockstep. Mirrors the WriteCommunityProjection convention — same
// tx as the settlement, log+continue on failure at the call site.
//
// What this does NOT do (yet): credit the author's Oz balance on a
// 'won' outcome. The win-bonus Oz credit is a follow-up PR; this PR
// closes the foundational gap (analyses.outcome was never being
// written). The leaderboard's ROI column populates the moment this
// lands.
//
// Outcome derivation rules (settlement path only — cashout sets
// 'cashed_out_void' from the TS side):
//   actual_payout_micro > stake_micro  → 'won'
//   actual_payout_micro = stake_micro  → 'void'   (stake refunded)
//   actual_payout_micro < stake_micro  → 'lost'
//
// community_author_stats math:
//   - settled_analyses bumps on 'won' or 'lost' (voids don't count;
//     they're not predictions). Matches the AnalysisAuthorStats
//     breakdown on the TS side where `voids` is separate.
//   - won_analyses bumps on 'won'.
//   - win_rate_pct NULL until settled_analyses >= 3 (PRD sample floor,
//     same convention as the existing inspired_turnover_micro reads).

package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// WriteAnalysisSettlementProjection finds any published analysis
// attached to `ticketID`, flips its outcome from NULL to a concrete
// value derived from the ticket's actual_payout_micro vs stake_micro,
// stamps settled_at, and bumps community_author_stats accordingly.
// Idempotent on `outcome IS NULL` — a re-settle without a prior reverse
// no-ops.
//
// Must run inside the settlement tx so the analyses projection and the
// underlying ticket state never diverge. Failure is logged + continued
// at the call site (admin backfill is the recovery path — same as
// WriteCommunityProjection).
func WriteAnalysisSettlementProjection(ctx context.Context, tx pgx.Tx, ticketID string) error {
	// One statement, two CTEs. `updated` flips the outcome and returns
	// the (author_id, outcome) pair only on a fresh write — `WHERE
	// outcome IS NULL` makes the UPDATE idempotent. The INSERT into
	// community_author_stats then runs only when `updated` yielded a
	// row AND the outcome is 'won' or 'lost' (voids don't count toward
	// the win-rate denominator).
	const q = `
WITH t AS (
  SELECT
    id,
    stake_micro,
    COALESCE(actual_payout_micro, 0) AS payout_micro,
    settled_at
    FROM tickets
   WHERE id = $1
     AND status = 'settled'
),
updated AS (
  UPDATE analyses a
     SET outcome    = CASE
                        WHEN t.payout_micro > t.stake_micro THEN 'won'
                        WHEN t.payout_micro = t.stake_micro THEN 'void'
                        ELSE 'lost'
                      END::analysis_outcome,
         settled_at = COALESCE(a.settled_at, t.settled_at, NOW())
    FROM t
   WHERE a.ticket_id = t.id
     AND a.status    = 'published'
     AND a.outcome   IS NULL
  RETURNING a.author_id, a.outcome
)
INSERT INTO community_author_stats AS cas (
  user_id,
  settled_analyses,
  won_analyses,
  win_rate_pct,
  updated_at
)
SELECT
  u.author_id,
  1,
  CASE WHEN u.outcome = 'won' THEN 1 ELSE 0 END,
  -- First-ever settlement: sample size is 1, below the floor of 3.
  -- Keep NULL.
  NULL::int,
  NOW()
  FROM updated u
 WHERE u.outcome IN ('won', 'lost')
ON CONFLICT (user_id) DO UPDATE
   SET settled_analyses = cas.settled_analyses + EXCLUDED.settled_analyses,
       won_analyses     = cas.won_analyses     + EXCLUDED.won_analyses,
       win_rate_pct     = CASE
                            WHEN cas.settled_analyses + EXCLUDED.settled_analyses < 3 THEN NULL
                            ELSE ROUND(
                                   (cas.won_analyses + EXCLUDED.won_analyses) * 100.0
                                 / (cas.settled_analyses + EXCLUDED.settled_analyses)
                                 )::int
                          END,
       updated_at       = NOW()
`
	if _, err := tx.Exec(ctx, q, ticketID); err != nil {
		return fmt.Errorf("write analysis settlement projection: %w", err)
	}
	return nil
}

// ReverseAnalysisSettlementProjection undoes a prior settlement of any
// analysis attached to `ticketID`. Used by the bet_cancel and
// rollback_bet_settlement paths so the analyses projection mirrors the
// ticket state under reversal. The pair WriteAnalysisSettlement... +
// ReverseAnalysisSettlement... is symmetric: settle → reverse → settle
// nets to the same +1 bump on community_author_stats.
//
// Mechanics:
//   1. Capture the prior (author_id, outcome) before clearing it.
//   2. Set analyses.outcome = NULL, settled_at = NULL — gates the next
//      forward run via `WHERE outcome IS NULL`.
//   3. Decrement community_author_stats by exactly the inverse of what
//      the forward path added (no-op for void rows, since they didn't
//      bump stats in the first place).
//
// Idempotent: a second reverse against an already-cleared analysis
// no-ops because `prior` is empty.
func ReverseAnalysisSettlementProjection(ctx context.Context, tx pgx.Tx, ticketID string) error {
	const q = `
WITH prior AS (
  UPDATE analyses
     SET outcome    = NULL,
         settled_at = NULL
   WHERE ticket_id = $1
     AND status    = 'published'
     AND outcome   IS NOT NULL
  RETURNING author_id, outcome
),
adjustments AS (
  SELECT
    p.author_id,
    -- Match the forward path: voids never contributed, so they
    -- subtract 0/0. won contributed (1, 1); lost contributed (1, 0).
    CASE WHEN p.outcome IN ('won', 'lost') THEN 1 ELSE 0 END AS settled_delta,
    CASE WHEN p.outcome = 'won' THEN 1 ELSE 0 END            AS won_delta
    FROM prior p
)
UPDATE community_author_stats cas
   SET settled_analyses = GREATEST(0, cas.settled_analyses - a.settled_delta),
       won_analyses     = GREATEST(0, cas.won_analyses     - a.won_delta),
       win_rate_pct     = CASE
                            WHEN GREATEST(0, cas.settled_analyses - a.settled_delta) < 3 THEN NULL
                            ELSE ROUND(
                                   GREATEST(0, cas.won_analyses     - a.won_delta) * 100.0
                                 / GREATEST(1, cas.settled_analyses - a.settled_delta)
                                 )::int
                          END,
       updated_at       = NOW()
  FROM adjustments a
 WHERE cas.user_id = a.author_id
   AND a.settled_delta > 0
`
	if _, err := tx.Exec(ctx, q, ticketID); err != nil {
		return fmt.Errorf("reverse analysis settlement projection: %w", err)
	}
	return nil
}
