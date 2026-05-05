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
// non-empty we attempt to resolve match_id via a subquery against
// matches.provider_urn; the lookup can race the auto-mapper (the very
// first messages for a brand-new match URN arrive before the match
// row exists), so unresolved rows are stored with match_id = NULL.
// The admin endpoints join on event_urn so orphans still show up; the
// nightly backfill in SweepFeedMessages closes the loop later.
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

// SweepFeedMessages keeps feed_messages bounded by a uniform 7-day
// retention window since received_at, then backfills match_id for
// rows whose URN now resolves (resolves the insert-time race with
// the auto-mapper). Returns the number of rows deleted for logging.
func SweepFeedMessages(ctx context.Context, db pgxRunner) (int64, error) {
	const deleteQ = `
DELETE FROM feed_messages
 WHERE received_at < NOW() - INTERVAL '7 days'
`
	tag, err := db.Exec(ctx, deleteQ)
	if err != nil {
		return 0, fmt.Errorf("sweep feed_messages: %w", err)
	}

	const backfillQ = `
UPDATE feed_messages fm
   SET match_id = ma.id
  FROM matches ma
 WHERE fm.match_id IS NULL
   AND fm.event_urn IS NOT NULL
   AND ma.provider_urn = fm.event_urn
`
	if _, err := db.Exec(ctx, backfillQ); err != nil {
		return tag.RowsAffected(), fmt.Errorf("backfill feed_messages match_id: %w", err)
	}
	return tag.RowsAffected(), nil
}
