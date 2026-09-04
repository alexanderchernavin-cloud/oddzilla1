package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ReadFonbetSwitch returns the operator's Fonbet feed position from the
// feed_control singleton (migration 0096): nil when never switched from
// the backoffice (the FONBET_ENABLED env default applies), otherwise the
// explicit true / false, which wins over env. Also nil when the row is
// missing (fresh database before the api has written it).
//
// Postgres, not Redis, on purpose: production Redis is an allkeys-lru
// cache that evicted the first cut of the Oddin source switch on day one.
func ReadFonbetSwitch(ctx context.Context, db pgxRunner) (*bool, error) {
	var enabled *bool
	err := db.QueryRow(ctx, `SELECT fonbet_enabled FROM feed_control WHERE id = 1`).Scan(&enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read fonbet switch: %w", err)
	}
	return enabled, nil
}

// AckFonbetSwitch records what the ingester is actually doing (true =
// polling Fonbet, false = catalog suspended and idle) so the backoffice
// card can show "applied" next to the requested position.
func AckFonbetSwitch(ctx context.Context, db pgxRunner, enabled bool) error {
	_, err := db.Exec(ctx, `
UPDATE feed_control
   SET fonbet_applied_enabled = $1,
       fonbet_applied_at      = NOW(),
       updated_at             = NOW()
 WHERE id = 1`, enabled)
	if err != nil {
		return fmt.Errorf("ack fonbet switch: %w", err)
	}
	return nil
}
