// Recovery helpers for the auto-recovery path on AMQP (re)connect.
//
// FlushAndSuspendActiveCatalog mirrors the admin manual recovery route's
// `flushOdds=true` step sequence (see services/api/src/modules/admin/feed.ts).
// Called from cmd/feed-ingester/main.go's OnConnect hook when the AMQP
// cursor is too stale to trust an overlay replay — typically after a
// service / DB outage longer than the operator-configured threshold.
//
// Pattern: suspend everything we currently treat as bettable, then let
// Oddin's recovery replay re-activate whatever's still in their active
// state. Anything Oddin doesn't replay stays suspended → drops out of
// the catalog naturally instead of carrying stale pre-outage state.

package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

type FlushSummary struct {
	DeletedMarkets    int64
	DeletedMatches    int64
	SuspendedMarkets  int64
	SuspendedOutcomes int64
}

// FlushAndSuspendActiveCatalog runs the three-step suspend-before-recover
// sequence inside a single transaction so the catalog is never observed
// half-flushed. Money-attached markets (`ticket_selections` or
// `settlements` FK present) are physically protected from deletion by
// the RESTRICT FKs; they fall through to the SUSPEND step. Settlements
// are append-only and never touched. Closed/cancelled matches are
// never touched — those are terminal history.
func FlushAndSuspendActiveCatalog(ctx context.Context, pool *pgxpool.Pool) (FlushSummary, error) {
	var s FlushSummary
	tx, err := pool.Begin(ctx)
	if err != nil {
		return s, fmt.Errorf("flush: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Step 1: hard-delete markets on not_started/live matches with
	// nothing money-attached. Cascades to market_outcomes via FK.
	tag, err := tx.Exec(ctx, `
		DELETE FROM markets m
		 USING matches ma
		 WHERE m.match_id = ma.id
		   AND ma.status IN ('not_started', 'live')
		   AND NOT EXISTS (
		     SELECT 1 FROM ticket_selections ts WHERE ts.market_id = m.id
		   )
		   AND NOT EXISTS (
		     SELECT 1 FROM settlements s WHERE s.market_id = m.id
		   )
	`)
	if err != nil {
		return s, fmt.Errorf("flush: delete orphan markets: %w", err)
	}
	s.DeletedMarkets = tag.RowsAffected()

	// Step 2: hard-delete matches left with no markets. Cascades to
	// feed_messages; the recovery replay re-populates as messages land.
	tag, err = tx.Exec(ctx, `
		DELETE FROM matches ma
		 WHERE ma.status IN ('not_started', 'live')
		   AND NOT EXISTS (
		     SELECT 1 FROM markets m WHERE m.match_id = ma.id
		   )
	`)
	if err != nil {
		return s, fmt.Errorf("flush: delete orphan matches: %w", err)
	}
	s.DeletedMatches = tag.RowsAffected()

	// Step 3a: suspend surviving active markets. Money-attached ones
	// that step 1 couldn't touch land here so bet placement stays
	// blocked until the replay re-publishes prices.
	tag, err = tx.Exec(ctx, `
		UPDATE markets
		   SET status = -1, updated_at = NOW()
		  FROM matches ma
		 WHERE ma.id = markets.match_id
		   AND markets.status = 1
		   AND ma.status IN ('not_started', 'live')
	`)
	if err != nil {
		return s, fmt.Errorf("flush: suspend markets: %w", err)
	}
	s.SuspendedMarkets = tag.RowsAffected()

	// Step 3b: null the outcome odds + probability for those suspended
	// markets so bet-slip pricing and Tiple/Tippot can't fire off stale
	// values during the recovery gap.
	tag, err = tx.Exec(ctx, `
		UPDATE market_outcomes
		   SET published_odds = NULL,
		       raw_odds       = NULL,
		       probability    = NULL,
		       active         = FALSE,
		       updated_at     = NOW()
		  FROM markets m
		  JOIN matches ma ON ma.id = m.match_id
		 WHERE market_outcomes.market_id = m.id
		   AND ma.status IN ('not_started', 'live')
	`)
	if err != nil {
		return s, fmt.Errorf("flush: null outcomes: %w", err)
	}
	s.SuspendedOutcomes = tag.RowsAffected()

	if err := tx.Commit(ctx); err != nil {
		return s, fmt.Errorf("flush: commit: %w", err)
	}
	return s, nil
}
