package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ReadAfterTs returns the recovery watermark for a producer key. Returns 0
// (and no error) if no row exists — safe default for first-run ingesters.
func ReadAfterTs(ctx context.Context, db pgxRunner, key string) (int64, error) {
	const q = `SELECT after_ts FROM amqp_state WHERE key = $1`
	var ts int64
	err := db.QueryRow(ctx, q, key).Scan(&ts)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, fmt.Errorf("read after_ts[%s]: %w", key, err)
	}
	return ts, nil
}

// BumpAfterTs sets after_ts to GREATEST(current, new). Never regresses.
func BumpAfterTs(ctx context.Context, db pgxRunner, key string, afterTs int64) error {
	const q = `
INSERT INTO amqp_state (key, after_ts, updated_at)
VALUES ($1, $2, NOW())
ON CONFLICT (key) DO UPDATE
   SET after_ts = GREATEST(amqp_state.after_ts, EXCLUDED.after_ts),
       updated_at = NOW()
`
	if _, err := db.Exec(ctx, q, key, afterTs); err != nil {
		return fmt.Errorf("bump after_ts[%s]: %w", key, err)
	}
	return nil
}

// RewindAfterTs unconditionally overwrites after_ts. Used by the
// flush-before-recover path on AMQP (re)connect: the flush suspends the
// entire active catalog, so the subsequent recovery must replay a wide
// enough window for Oddin to re-confirm everything it still considers
// active. The natural BumpAfterTs path keeps the cursor pinned to "now
// minus a few seconds" (the timestamp of the last processed odds_change),
// which would shrink the replay window to nothing and leave stable
// prematch markets stuck at status=-1. Callers should run this from the
// OnConnect callback, BEFORE the consumer starts reading deliveries —
// at that point no handler goroutine can concurrently call BumpAfterTs
// and race the rewind forward.
func RewindAfterTs(ctx context.Context, db pgxRunner, key string, afterTs int64) error {
	const q = `
INSERT INTO amqp_state (key, after_ts, updated_at)
VALUES ($1, $2, NOW())
ON CONFLICT (key) DO UPDATE
   SET after_ts = EXCLUDED.after_ts,
       updated_at = NOW()
`
	if _, err := db.Exec(ctx, q, key, afterTs); err != nil {
		return fmt.Errorf("rewind after_ts[%s]: %w", key, err)
	}
	return nil
}
