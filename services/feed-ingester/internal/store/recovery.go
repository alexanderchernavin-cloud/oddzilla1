// Recovery helpers for the auto-recovery path on AMQP (re)connect.
//
// FlushAndSuspendActiveCatalog flips every currently-active market on a
// not_started/live match to status=-1 and nulls its outcome odds /
// probability. Called from cmd/feed-ingester/main.go's OnConnect hook
// before InitiateRecovery so anything Oddin's replay doesn't re-activate
// stays suspended → drops from the storefront via the catalog filter.
//
// We do NOT delete orphan rows here (unlike the admin manual recovery
// route's `flushOdds=true` path). Reason: the auto-path runs on every
// AMQP reconnect including normal blips during heavy settlement
// traffic, and the bulk DELETE races with concurrent settlement
// INSERTs — `settlements.market_id` has no ON DELETE action so a race
// produces an FK violation that aborts the whole transaction. SUSPEND
// is race-safe (UPDATE on the parent doesn't trip child FKs) and
// sufficient for correctness: catalog visibility gates on
// `markets.status=1`, so a suspended row is invisible whether or not
// the parent match is still in the DB. The admin manual route keeps
// its DELETE step for operator-initiated full-catalog rebuilds where
// the race isn't a concern.

package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

type FlushSummary struct {
	SuspendedMarkets  int64
	SuspendedOutcomes int64
	// SuspendedRefs is the (matchID, marketID) list for every market
	// this call flipped from active to suspended. The caller publishes
	// a `marketStatus` WS frame per ref so storefront sessions holding
	// these matches lock their bet slips immediately — without it the
	// page keeps displaying the pre-flush prices until Oddin's recovery
	// replay reaches them (seconds), and any click in that window dead-
	// ends at placement with `market_not_active`.
	SuspendedRefs []FlushSuspendedRef
}

// FlushSuspendedRef pairs each suspended market with its match for the
// pub/sub channel address (`odds:match:{matchID}`).
type FlushSuspendedRef struct {
	MatchID  int64
	MarketID int64
}

// FlushAndSuspendActiveCatalog suspends every active market on a
// not_started/live match in a single transaction. Race-safe: UPDATE on
// markets/market_outcomes doesn't trigger FK checks on settlements or
// ticket_selections, so it can run during live settlement traffic.
// Closed/cancelled matches are untouched (terminal history).
func FlushAndSuspendActiveCatalog(ctx context.Context, pool *pgxpool.Pool) (FlushSummary, error) {
	var s FlushSummary
	tx, err := pool.Begin(ctx)
	if err != nil {
		return s, fmt.Errorf("flush: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Step 1: suspend currently-active markets. Bet placement and the
	// storefront catalog filter both reject status != 1 so nothing is
	// bettable until the replay re-publishes prices.
	//
	// RETURNING captures (match_id, id) so the caller can publish a
	// marketStatus frame per affected market on the WS bus. Without
	// that emission the storefront stays on stale pre-flush prices for
	// the duration of the recovery replay.
	rows, err := tx.Query(ctx, `
		UPDATE markets
		   SET status = -1, updated_at = NOW()
		  FROM matches ma
		 WHERE ma.id = markets.match_id
		   AND markets.status = 1
		   AND ma.status IN ('not_started', 'live')
		RETURNING markets.match_id, markets.id
	`)
	if err != nil {
		return s, fmt.Errorf("flush: suspend markets: %w", err)
	}
	refs := make([]FlushSuspendedRef, 0, 256)
	for rows.Next() {
		var r FlushSuspendedRef
		if err := rows.Scan(&r.MatchID, &r.MarketID); err != nil {
			rows.Close()
			return s, fmt.Errorf("flush: scan suspended ref: %w", err)
		}
		refs = append(refs, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return s, fmt.Errorf("flush: iterate suspended refs: %w", err)
	}
	s.SuspendedMarkets = int64(len(refs))
	s.SuspendedRefs = refs

	// Step 2: null the outcome odds + probability for every outcome
	// on a not_started/live match. Covers two cases:
	//   - outcomes under markets we just suspended above
	//   - outcomes that were already inactive (status != 1) but still
	//     carried stale odds — anything visible to the bet-slip or
	//     Tiple/Tippot priceability checks gets zeroed out so the
	//     replay refills them with truth.
	tag, err := tx.Exec(ctx, `
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
