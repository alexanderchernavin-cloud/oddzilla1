// Redis Streams abstraction for the internal event bus. Currently only
// publishes `odds.raw` — odds-publisher is the sole consumer. Designed so a
// Kafka backend is an adapter swap once we move off the single Hetzner box.

package bus

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

const (
	// StreamOddsRaw is the stream name used by feed-ingester (producer) and
	// odds-publisher (consumer). Each entry corresponds to one outcome
	// update. Consumers use XREADGROUP and track their own cursor.
	StreamOddsRaw = "odds.raw"

	// MaxLenApprox trims the stream to roughly this many entries. Oddin
	// can burst ~2000/s during live; 100k gives us ~minutes of retention
	// even in the worst case. Trimming is approximate (~ cheaper than
	// exact) — good enough for a stream-as-bus pattern.
	MaxLenApprox = 100_000
)

// OddsEvent is what we publish per outcome update. Kept small — stream
// entries are in Redis memory until consumed and trimmed.
type OddsEvent struct {
	MarketID      int64
	OutcomeID     string
	ProviderMarketID int
	SpecifiersCanonical string // sorted k=v|k=v; hash can be derived
	RawOdds       string // decimal string
	Active        bool
	MatchID       int64
	OddinTs       int64 // source timestamp, ms
}

// Bus publishes odds events onto Redis Streams.
type Bus struct {
	rdb *redis.Client
}

func New(rdb *redis.Client) *Bus {
	return &Bus{rdb: rdb}
}

// PublishOdds writes one event per outcome to `odds.raw`.
func (b *Bus) PublishOdds(ctx context.Context, ev OddsEvent) error {
	fields := map[string]any{
		"market_id":         ev.MarketID,
		"outcome_id":        ev.OutcomeID,
		"provider_market_id": ev.ProviderMarketID,
		"specifiers":        ev.SpecifiersCanonical,
		"raw_odds":          ev.RawOdds,
		"active":            boolInt(ev.Active),
		"match_id":          ev.MatchID,
		"oddin_ts":          ev.OddinTs,
	}
	if err := b.rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: StreamOddsRaw,
		MaxLen: MaxLenApprox,
		Approx: true,
		Values: fields,
	}).Err(); err != nil {
		return fmt.Errorf("xadd %s: %w", StreamOddsRaw, err)
	}
	return nil
}

// PublishOddsBatch is a micro-optimization for bursts: pipelines N XADDs in
// one round trip. Errors are returned as a single multi-error if any fail.
func (b *Bus) PublishOddsBatch(ctx context.Context, events []OddsEvent) error {
	if len(events) == 0 {
		return nil
	}
	pipe := b.rdb.Pipeline()
	for _, ev := range events {
		pipe.XAdd(ctx, &redis.XAddArgs{
			Stream: StreamOddsRaw,
			MaxLen: MaxLenApprox,
			Approx: true,
			Values: map[string]any{
				"market_id":         ev.MarketID,
				"outcome_id":        ev.OutcomeID,
				"provider_market_id": ev.ProviderMarketID,
				"specifiers":        ev.SpecifiersCanonical,
				"raw_odds":          ev.RawOdds,
				"active":            boolInt(ev.Active),
				"match_id":          ev.MatchID,
				"oddin_ts":          ev.OddinTs,
			},
		})
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("pipeline xadd: %w", err)
	}
	return nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
