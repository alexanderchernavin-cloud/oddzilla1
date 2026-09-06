package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// CloseMatchesWithTerminalBooks flips to `closed` every match that is past
// its start by a wide margin, still carries a non-terminal lifecycle status,
// and whose EVERY market has already reached -3 / -4. Returns the ids so
// the caller can voice the transition.
//
// Why a sweep and not just MarkMatchClosedIfAllMarketsTerminal: that
// function runs once per settlement message for that message's event, so
// a match whose last market went terminal by another route — the ladder
// inference, an operator void, a grader pass that ran while the match row
// still said not_started because the Fonbet event had left the line before
// it kicked off (fonbet-ingester deactivates a vanished prematch event's
// markets but never touches the match row) — has nothing left to trigger
// the flip and sits at not_started or live with a fully settled book. 94
// fixtures that started on 2026-09-05 were in that state a day later.
//
// Three hours past kick-off is the same margin the Fonbet grader uses to
// start looking a not_started match up in the results feed. EXISTS on
// markets keeps outright placeholders and market-less fixtures out: a
// match with no markets at all has no book to be terminal.
func CloseMatchesWithTerminalBooks(ctx context.Context, pool *pgxpool.Pool) ([]int64, error) {
	rows, err := pool.Query(ctx, `
UPDATE matches m
   SET status = 'closed'::match_status, updated_at = NOW()
 WHERE m.status::text IN ('not_started', 'live', 'suspended')
   AND m.scheduled_at < NOW() - INTERVAL '3 hours'
   AND m.scheduled_at > NOW() - INTERVAL '30 days'
   AND EXISTS (SELECT 1 FROM markets mk WHERE mk.match_id = m.id)
   AND NOT EXISTS (SELECT 1 FROM markets mk WHERE mk.match_id = m.id AND mk.status NOT IN (-3, -4))
RETURNING m.id`)
	if err != nil {
		return nil, fmt.Errorf("close matches with terminal books: %w", err)
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
