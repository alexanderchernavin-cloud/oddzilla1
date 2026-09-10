package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/oddzilla/slotzilla/internal/sportradar"
)

// The DO UPDATE is guarded so a delta re-sending the same eight events
// every 3 s writes nothing: a rewrite would bump updated_at, which is the
// grace clock after a restart, and would double the row churn for no
// information. RETURNING therefore names exactly the events that changed.
const sqlUpsertEvent = `
INSERT INTO sr_live_events
  (sr_event_id, sr_match_id, match_id, type, symbol, team, points, seconds, uts, updated_uts,
   disabled, period, player_id, player_name, raw)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
ON CONFLICT (sr_event_id) DO UPDATE
   SET match_id = COALESCE(EXCLUDED.match_id, sr_live_events.match_id),
       updated_uts = EXCLUDED.updated_uts,
       disabled = EXCLUDED.disabled,
       symbol = EXCLUDED.symbol,
       team = EXCLUDED.team,
       points = EXCLUDED.points,
       seconds = EXCLUDED.seconds,
       raw = EXCLUDED.raw,
       updated_at = now()
 WHERE sr_live_events.updated_uts IS DISTINCT FROM EXCLUDED.updated_uts
    OR sr_live_events.disabled IS DISTINCT FROM EXCLUDED.disabled
    OR sr_live_events.seconds IS DISTINCT FROM EXCLUDED.seconds
    OR sr_live_events.symbol IS DISTINCT FROM EXCLUDED.symbol
    OR (sr_live_events.match_id IS NULL AND EXCLUDED.match_id IS NOT NULL)
RETURNING sr_event_id`

// UpsertEvents writes the rows of one fetch in a single batch and returns
// the ids that were inserted or changed. matchID may be nil for corpus
// rows (the api's fetch); the service always has one.
func (s *Store) UpsertEvents(ctx context.Context, matchID *int64, rows []sportradar.EventRow) ([]int64, error) {
	if len(rows) == 0 {
		return nil, nil
	}
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(sqlUpsertEvent,
			r.SrEventID, r.SrMatchID, matchID, r.Type, nullString(r.Symbol), nullString(r.Team), r.Points,
			r.Seconds, r.UTS, r.UpdatedUTS, r.Disabled, r.Period, r.PlayerID, nullString(r.PlayerName), string(r.Raw))
	}
	br := s.pool.SendBatch(ctx, batch)
	defer br.Close()
	var changed []int64
	for i := range rows {
		id, ok, err := scanOptionalID(br.Query())
		if err != nil {
			return changed, fmt.Errorf("upsert event %d: %w", rows[i].SrEventID, err)
		}
		if ok {
			changed = append(changed, id)
		}
	}
	return changed, nil
}

func scanOptionalID(rows pgx.Rows, err error) (int64, bool, error) {
	if err != nil {
		return 0, false, err
	}
	defer rows.Close()
	if !rows.Next() {
		return 0, false, rows.Err()
	}
	var id int64
	if err := rows.Scan(&id); err != nil {
		return 0, false, err
	}
	return id, true, rows.Err()
}

// Event is the stored slice of an event the reel derivation and the
// grace clock read.
type Event struct {
	ID         int64
	Symbol     string
	Team       string
	Seconds    int
	Disabled   bool
	UpdatedUTS int64
	// UpdatedAt is when this row last changed in OUR database: the grace
	// period is measured from it, since the scout's own stamp lags wall
	// clock by the feed delay.
	UpdatedAt time.Time
}

const sqlLoadEvents = `
SELECT sr_event_id, COALESCE(symbol, ''), COALESCE(team, ''), seconds, disabled, updated_uts, updated_at
  FROM sr_live_events
 WHERE sr_match_id = $1
 ORDER BY seconds, sr_event_id`

// LoadEvents returns every stored event of a Sportradar match, enabled or
// not (the reel derivation skips disabled ones itself).
func (s *Store) LoadEvents(ctx context.Context, srMatchID int64) ([]Event, error) {
	rows, err := s.pool.Query(ctx, sqlLoadEvents, srMatchID)
	if err != nil {
		return nil, fmt.Errorf("load events %d: %w", srMatchID, err)
	}
	defer rows.Close()
	var out []Event
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.ID, &e.Symbol, &e.Team, &e.Seconds, &e.Disabled, &e.UpdatedUTS, &e.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan event: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func nullString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
