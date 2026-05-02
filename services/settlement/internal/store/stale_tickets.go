// Stale-ticket queries for the periodic sweeper.
//
// A ticket is "stuck" when:
//   - tickets.status = 'accepted'
//   - at least one ticket_selections row has result IS NULL
//   - the unresolved selection's market belongs to a match whose
//     scheduled_at is in the past
//
// Two age windows matter:
//   - Recovery window (e.g. 5h ≤ age < 48h after scheduled_at): the match
//     should have finished but a settlement message either never arrived or
//     applied to a market we don't know about. We re-pull the fixture from
//     Oddin REST via pg_notify('fixture_refresh', urn) so the match status
//     gets corrected. The phantom_drain ticker in feed-ingester catches the
//     same matches independently — these queries narrow the work to ones
//     that actually have user money tied up.
//   - Void window (≥ 48h after scheduled_at): we give up and refund the
//     stuck legs as void. For combo tickets that means the stuck leg drops
//     to factor 1; for singles the stake is refunded. The settler's normal
//     `maybeSettleTicket` path handles the wallet/ledger update.

package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// StaleAcceptedMatchURNs returns provider_urns of matches that have at
// least one stuck `accepted` ticket selection (result IS NULL) whose
// match.scheduled_at is at least `minAgeHours` and at most `maxAgeHours`
// in the past.
//
// The bounded window keeps the recovery sweep from overlapping the void
// sweep — anything older than `maxAgeHours` is the void sweep's problem.
func StaleAcceptedMatchURNs(ctx context.Context, db *pgxpool.Pool, minAgeHours, maxAgeHours int) ([]string, error) {
	rows, err := db.Query(ctx, `
SELECT DISTINCT ma.provider_urn
  FROM tickets t
  JOIN ticket_selections ts ON ts.ticket_id = t.id
  JOIN markets m            ON m.id        = ts.market_id
  JOIN matches ma           ON ma.id       = m.match_id
 WHERE t.status         = 'accepted'
   AND ts.result IS NULL
   AND ma.scheduled_at IS NOT NULL
   AND ma.scheduled_at <  NOW() - make_interval(hours => $1)
   AND ma.scheduled_at >= NOW() - make_interval(hours => $2)
   AND ma.provider_urn LIKE 'od:match:%'
 ORDER BY ma.provider_urn`, minAgeHours, maxAgeHours)
	if err != nil {
		return nil, fmt.Errorf("stale match urns: %w", err)
	}
	defer rows.Close()
	out := make([]string, 0, 16)
	for rows.Next() {
		var urn string
		if err := rows.Scan(&urn); err != nil {
			return nil, fmt.Errorf("scan stale urn: %w", err)
		}
		out = append(out, urn)
	}
	return out, rows.Err()
}

// StaleAcceptedTicketIDs returns ticket UUIDs that are still `accepted`
// and have at least one unresolved selection whose match scheduled_at is
// more than `minAgeHours` in the past.
//
// Note: a ticket with one stale leg AND one future-match leg WILL appear
// here — that's intentional. The caller voids only the stale leg(s); the
// future leg keeps the ticket in `accepted` until it resolves or the
// future match itself ages past the void threshold.
func StaleAcceptedTicketIDs(ctx context.Context, db *pgxpool.Pool, minAgeHours, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := db.Query(ctx, `
SELECT DISTINCT t.id
  FROM tickets t
  JOIN ticket_selections ts ON ts.ticket_id = t.id
  JOIN markets m            ON m.id        = ts.market_id
  JOIN matches ma           ON ma.id       = m.match_id
 WHERE t.status         = 'accepted'
   AND ts.result IS NULL
   AND ma.scheduled_at IS NOT NULL
   AND ma.scheduled_at < NOW() - make_interval(hours => $1)
 ORDER BY t.id
 LIMIT $2`, minAgeHours, limit)
	if err != nil {
		return nil, fmt.Errorf("stale ticket ids: %w", err)
	}
	defer rows.Close()
	out := make([]string, 0, 16)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan stale ticket id: %w", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// VoidStaleSelectionsForTicket marks every still-unresolved selection on
// `ticketID` as void (result=void, void_factor=1) when its match's
// scheduled_at is more than `minAgeHours` in the past. Selections whose
// match is in the future or recently scheduled are left untouched, so a
// combo with a future-match leg keeps that leg active.
//
// Returns the number of rows updated. Zero means nothing was eligible —
// either every selection was already resolved (race with an arriving
// settlement) or the stale ages didn't match.
func VoidStaleSelectionsForTicket(ctx context.Context, tx pgx.Tx, ticketID string, minAgeHours int) (int64, error) {
	tag, err := tx.Exec(ctx, `
UPDATE ticket_selections ts
   SET result      = 'void'::outcome_result,
       void_factor = 1,
       settled_at  = NOW()
  FROM markets m
  JOIN matches ma ON ma.id = m.match_id
 WHERE ts.market_id = m.id
   AND ts.ticket_id = $1
   AND ts.result IS NULL
   AND ma.scheduled_at IS NOT NULL
   AND ma.scheduled_at < NOW() - make_interval(hours => $2)`,
		ticketID, minAgeHours,
	)
	if err != nil {
		return 0, fmt.Errorf("void stale selections: %w", err)
	}
	return tag.RowsAffected(), nil
}

// NotifyFixtureRefresh fires pg_notify('fixture_refresh', urn). The
// feed-ingester's listener re-fetches the fixture from Oddin REST and
// updates matches.status. Per-URN cooldown (5 min) is enforced inside
// that listener, so spamming the same URN across consecutive sweeps is
// safe.
func NotifyFixtureRefresh(ctx context.Context, db *pgxpool.Pool, urn string) error {
	if _, err := db.Exec(ctx, `SELECT pg_notify('fixture_refresh', $1)`, urn); err != nil {
		return fmt.Errorf("pg_notify fixture_refresh: %w", err)
	}
	return nil
}
