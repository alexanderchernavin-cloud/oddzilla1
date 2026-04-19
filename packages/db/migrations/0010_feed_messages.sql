-- Admin-visible raw AMQP message log. Feed-ingester writes one row per
-- Oddin message it processes (odds_change, fixture_change, bet_stop,
-- bet_settlement, bet_cancel, rollback_bet_settlement, rollback_bet_cancel)
-- so the /admin/logs panel can replay per-match what hit the broker.
--
-- Retention is tied to match.scheduled_at + 24h; a cleanup goroutine in
-- feed-ingester deletes rows once their match falls out of the window.
-- Rows with NULL match_id (URN that never resolved to a match row) are
-- dropped after 48h as a hard safety bound.

CREATE TABLE IF NOT EXISTS feed_messages (
    id           BIGSERIAL PRIMARY KEY,
    match_id     BIGINT REFERENCES matches(id) ON DELETE CASCADE,
    event_urn    TEXT,
    kind         TEXT NOT NULL,
    routing_key  TEXT,
    product      SMALLINT,
    payload_xml  TEXT NOT NULL,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS feed_messages_match_ts_idx
    ON feed_messages (match_id, received_at DESC)
    WHERE match_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS feed_messages_received_idx
    ON feed_messages (received_at);

CREATE INDEX IF NOT EXISTS feed_messages_event_urn_idx
    ON feed_messages (event_urn, received_at DESC)
    WHERE event_urn IS NOT NULL;
