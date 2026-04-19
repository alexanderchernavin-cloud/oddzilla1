package store

import (
	"context"
	"fmt"
)

// FeedMessageInsert carries the fields persisted to feed_messages for
// admin-visible per-match replay. EventURN is the Oddin `event_id`
// attribute on the XML root; an empty string skips the match lookup
// and stores match_id = NULL (used for system-level kinds that are
// still worth keeping for debugging).
type FeedMessageInsert struct {
	EventURN   string
	Kind       string
	RoutingKey string
	Product    int16
	PayloadXML []byte
}

// InsertFeedMessage appends one row to feed_messages. If event_urn is
// non-empty, match_id is resolved via a subquery against matches.
// provider_urn; unresolved URNs are stored as match_id = NULL and the
// cleanup sweeper drops them after 48h regardless.
func InsertFeedMessage(ctx context.Context, db pgxRunner, m FeedMessageInsert) error {
	const q = `
INSERT INTO feed_messages (match_id, event_urn, kind, routing_key, product, payload_xml)
VALUES (
    CASE WHEN $1 = '' THEN NULL
         ELSE (SELECT id FROM matches WHERE provider_urn = $1 LIMIT 1)
    END,
    NULLIF($1, ''),
    $2,
    NULLIF($3, ''),
    NULLIF($4::int, 0),
    $5
)
`
	if _, err := db.Exec(ctx, q, m.EventURN, m.Kind, m.RoutingKey, int(m.Product), string(m.PayloadXML)); err != nil {
		return fmt.Errorf("insert feed_message: %w", err)
	}
	return nil
}

// SweepFeedMessages deletes rows whose associated match passed the
// retention window (scheduled_at + 24h) and unmapped rows older than
// the hard safety bound (48h since received). Returns the number of
// rows deleted for logging.
func SweepFeedMessages(ctx context.Context, db pgxRunner) (int64, error) {
	const q = `
DELETE FROM feed_messages fm
 WHERE fm.received_at < NOW() - INTERVAL '48 hours'
    OR (
        fm.match_id IS NOT NULL
        AND EXISTS (
            SELECT 1 FROM matches ma
             WHERE ma.id = fm.match_id
               AND ma.scheduled_at IS NOT NULL
               AND ma.scheduled_at + INTERVAL '24 hours' < NOW()
        )
    )
`
	tag, err := db.Exec(ctx, q)
	if err != nil {
		return 0, fmt.Errorf("sweep feed_messages: %w", err)
	}
	return tag.RowsAffected(), nil
}
