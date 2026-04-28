// Redis Streams consumer. Pulls odds events the feed-ingester XADDed onto
// `odds.raw` via a consumer group so multiple odds-publisher replicas can
// share work and each message is processed exactly once within the group.
//
// Behavior:
//   - Creates the consumer group on boot if it doesn't exist (idempotent).
//   - XREADGROUP with BLOCK so the goroutine doesn't spin when idle.
//   - On each batch: invokes handler, then XACKs successes.
//   - Periodically XAUTOCLAIMs entries pending for other consumers that
//     have gone away (e.g. container rescheduled). Idle threshold is
//     configurable via ClaimIdle.

package bus

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

const (
	// StreamOddsRaw is the stream the feed-ingester publishes to. Kept in
	// sync with feed-ingester/internal/bus/redis.go StreamOddsRaw.
	StreamOddsRaw = "odds.raw"
)

// Event is the decoded form of a single XADD entry.
type Event struct {
	ID                  string // Redis stream entry id "1700000000000-0"
	MarketID            int64
	OutcomeID           string
	ProviderMarketID    int
	SpecifiersCanonical string
	RawOdds             string
	Probability         string // "" when feed omits it
	Active              bool
	MatchID             int64
	OddinTs             int64
}

// Handler processes a batch of events. Return nil to XACK all, or an error
// to leave them pending (they'll be retried or auto-claimed later).
type Handler func(ctx context.Context, events []Event) error

// Consumer is the read loop.
type Consumer struct {
	rdb       *redis.Client
	group     string
	consumer  string
	batchSize int
	block     time.Duration
	claimIdle time.Duration
	handler   Handler
	log       zerolog.Logger
}

func NewConsumer(rdb *redis.Client, group, consumer string, batch int, block, claimIdle time.Duration, h Handler, log zerolog.Logger) *Consumer {
	return &Consumer{
		rdb:       rdb,
		group:     group,
		consumer:  consumer,
		batchSize: batch,
		block:     block,
		claimIdle: claimIdle,
		handler:   h,
		log:       log.With().Str("component", "bus").Logger(),
	}
}

// Run blocks until ctx is done. Idempotently creates the consumer group.
func (c *Consumer) Run(ctx context.Context) error {
	if err := c.ensureGroup(ctx); err != nil {
		return err
	}

	// Periodic claim in the background so pending entries don't starve if
	// a replica dies mid-batch. 30s cadence keeps load low and is well
	// within typical deployment heartbeats.
	go c.claimLoop(ctx)

	c.log.Info().
		Str("group", c.group).
		Str("consumer", c.consumer).
		Int("batch", c.batchSize).
		Msg("odds-publisher consumer running")

	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		res, err := c.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    c.group,
			Consumer: c.consumer,
			Streams:  []string{StreamOddsRaw, ">"}, // ">" = only new entries
			Count:    int64(c.batchSize),
			Block:    c.block,
		}).Result()
		if err != nil {
			if errors.Is(err, redis.Nil) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
				continue
			}
			c.log.Warn().Err(err).Msg("XReadGroup error; backing off")
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(2 * time.Second):
			}
			continue
		}
		for _, stream := range res {
			events := decodeBatch(stream.Messages)
			if err := c.handler(ctx, events); err != nil {
				c.log.Error().Err(err).Int("count", len(events)).Msg("handler error; leaving pending")
				continue
			}
			ids := make([]string, len(events))
			for i, ev := range events {
				ids[i] = ev.ID
			}
			if len(ids) > 0 {
				if err := c.rdb.XAck(ctx, StreamOddsRaw, c.group, ids...).Err(); err != nil {
					c.log.Warn().Err(err).Msg("XAck failed")
				}
			}
		}
	}
}

func (c *Consumer) ensureGroup(ctx context.Context) error {
	// MKSTREAM creates the stream if it doesn't exist so boot doesn't
	// fail when the ingester hasn't published anything yet.
	_, err := c.rdb.XGroupCreateMkStream(ctx, StreamOddsRaw, c.group, "$").Result()
	if err != nil && !isBusyGroupErr(err) {
		return fmt.Errorf("create group: %w", err)
	}
	return nil
}

func (c *Consumer) claimLoop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		var cursor string = "0-0"
		for {
			msgs, nextCursor, err := c.rdb.XAutoClaim(ctx, &redis.XAutoClaimArgs{
				Stream:   StreamOddsRaw,
				Group:    c.group,
				Consumer: c.consumer,
				MinIdle:  c.claimIdle,
				Start:    cursor,
				Count:    int64(c.batchSize),
			}).Result()
			if err != nil && !errors.Is(err, redis.Nil) {
				c.log.Debug().Err(err).Msg("XAutoClaim error")
				break
			}
			if len(msgs) == 0 {
				break
			}
			events := decodeBatch(msgs)
			if err := c.handler(ctx, events); err != nil {
				c.log.Warn().Err(err).Int("count", len(events)).Msg("handler error during claim; leaving pending")
				break
			}
			ids := make([]string, len(events))
			for i, ev := range events {
				ids[i] = ev.ID
			}
			if err := c.rdb.XAck(ctx, StreamOddsRaw, c.group, ids...).Err(); err != nil {
				c.log.Warn().Err(err).Msg("XAck failed during claim")
			}
			if nextCursor == "0-0" || nextCursor == "" {
				break
			}
			cursor = nextCursor
		}
	}
}

func decodeBatch(msgs []redis.XMessage) []Event {
	out := make([]Event, 0, len(msgs))
	for _, m := range msgs {
		ev := Event{ID: m.ID}
		if v, ok := m.Values["market_id"].(string); ok {
			ev.MarketID, _ = strconv.ParseInt(v, 10, 64)
		}
		if v, ok := m.Values["outcome_id"].(string); ok {
			ev.OutcomeID = v
		}
		if v, ok := m.Values["provider_market_id"].(string); ok {
			n, _ := strconv.Atoi(v)
			ev.ProviderMarketID = n
		}
		if v, ok := m.Values["specifiers"].(string); ok {
			ev.SpecifiersCanonical = v
		}
		if v, ok := m.Values["raw_odds"].(string); ok {
			ev.RawOdds = v
		}
		if v, ok := m.Values["probability"].(string); ok {
			ev.Probability = v
		}
		if v, ok := m.Values["active"].(string); ok {
			ev.Active = v == "1"
		}
		if v, ok := m.Values["match_id"].(string); ok {
			ev.MatchID, _ = strconv.ParseInt(v, 10, 64)
		}
		if v, ok := m.Values["oddin_ts"].(string); ok {
			ev.OddinTs, _ = strconv.ParseInt(v, 10, 64)
		}
		out = append(out, ev)
	}
	return out
}

func isBusyGroupErr(err error) bool {
	return err != nil && err.Error() == "BUSYGROUP Consumer Group name already exists"
}
