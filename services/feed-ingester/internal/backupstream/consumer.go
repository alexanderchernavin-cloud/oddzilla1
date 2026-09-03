// Consumer for the `oddin.backup` Redis stream written by
// services/bifrost-feed. Each entry carries one Oddin-shaped XML document
// (odds_change / fixture_change / bet_settlement) synthesised from
// Bifrost; we hand the body to the very same handler.Handle the AMQP
// consumer uses, so the backup path inherits every guard the primary path
// has. Settlement-family kinds are ignored here (settlement has its own
// consumer group on the same stream), exactly as they are on AMQP.
//
// Delivery semantics: XREADGROUP with a per-service consumer group, ack
// after the handler returns. On boot we first drain our own pending list
// (id "0") so a crash between read and ack replays the entry; a handler
// error is retried a few times with backoff and then acked with an error
// log — Bifrost is state-based, so the next snapshot of the same match
// re-emits the same truth and nothing is permanently lost by dropping one
// entry.
//
// Intentionally duplicated in services/settlement/internal/backupstream
// per the one-Go-module-per-service rule.

package backupstream

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

const (
	// StreamName must match services/bifrost-feed/internal/publisher.
	StreamName = "oddin.backup"
	// RoutingKey is what the handler sees in place of the AMQP routing key;
	// it only feeds log lines and the feed_messages audit row.
	RoutingKey = "bifrost.backup"

	readBlock     = 5 * time.Second
	readCount     = 64
	handlerTries  = 3
	handlerPause  = time.Second
	reconnectWait = 2 * time.Second
)

// Handler mirrors the AMQP consumer's signature.
type Handler func(ctx context.Context, routingKey string, body []byte) error

// Run blocks until ctx is done. group is the per-service consumer group
// name; consumer identifies this process inside the group.
func Run(ctx context.Context, rdb *redis.Client, group, consumer string, h Handler, log zerolog.Logger) {
	log = log.With().Str("component", "backup-stream").Str("group", group).Logger()
	for ctx.Err() == nil {
		if err := runOnce(ctx, rdb, group, consumer, h, log); err != nil && ctx.Err() == nil {
			log.Warn().Err(err).Dur("retry_in", reconnectWait).Msg("backup stream consumer errored")
			select {
			case <-ctx.Done():
				return
			case <-time.After(reconnectWait):
			}
		}
	}
}

func runOnce(ctx context.Context, rdb *redis.Client, group, consumer string, h Handler, log zerolog.Logger) error {
	// MKSTREAM creates an empty stream so the group can exist before the
	// producer has ever published. BUSYGROUP just means it already exists.
	if err := rdb.XGroupCreateMkStream(ctx, StreamName, group, "0").Err(); err != nil && !strings.Contains(err.Error(), "BUSYGROUP") {
		return err
	}
	log.Info().Str("stream", StreamName).Str("consumer", consumer).Msg("backup stream consumer attached")

	// First pass reads our own pending entries (crash recovery), then ">"
	// for new deliveries.
	cursor := "0"
	for ctx.Err() == nil {
		res, err := rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    group,
			Consumer: consumer,
			Streams:  []string{StreamName, cursor},
			Count:    readCount,
			Block:    readBlock,
		}).Result()
		if err != nil {
			if errors.Is(err, redis.Nil) {
				cursor = ">"
				continue
			}
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		delivered := 0
		for _, stream := range res {
			for _, msg := range stream.Messages {
				delivered++
				handle(ctx, h, msg, log)
				if err := rdb.XAck(ctx, StreamName, group, msg.ID).Err(); err != nil {
					log.Warn().Err(err).Str("id", msg.ID).Msg("xack failed")
				}
			}
		}
		if cursor == "0" && delivered == 0 {
			cursor = ">"
		}
	}
	return nil
}

func handle(ctx context.Context, h Handler, msg redis.XMessage, log zerolog.Logger) {
	body := bodyOf(msg)
	if len(body) == 0 {
		log.Debug().Str("id", msg.ID).Msg("backup entry without body; skipping")
		return
	}
	for attempt := 1; attempt <= handlerTries; attempt++ {
		err := h(ctx, RoutingKey, body)
		if err == nil {
			return
		}
		if attempt == handlerTries || ctx.Err() != nil {
			log.Error().Err(err).Str("id", msg.ID).Str("kind", field(msg, "kind")).Str("event", field(msg, "event_urn")).
				Msg("backup entry dropped after retries")
			return
		}
		log.Warn().Err(err).Str("id", msg.ID).Int("attempt", attempt).Msg("backup entry handler error; retrying")
		select {
		case <-ctx.Done():
			return
		case <-time.After(handlerPause * time.Duration(attempt)):
		}
	}
}

func bodyOf(msg redis.XMessage) []byte {
	v, ok := msg.Values["body"]
	if !ok {
		return nil
	}
	switch b := v.(type) {
	case string:
		return []byte(b)
	case []byte:
		return b
	}
	return nil
}

func field(msg redis.XMessage, key string) string {
	if v, ok := msg.Values[key].(string); ok {
		return v
	}
	return ""
}
