// Redis Streams abstraction for the internal event bus. `odds.raw` feeds
// odds-publisher; `odds:match:{id}` is a pub/sub channel ws-gateway
// fans out to subscribed browsers (live scoreboard + ticket frames).
// Designed so a Kafka backend is an adapter swap once we move off the
// single Hetzner box.

package bus

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

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
	Probability   string // decimal in [0,1]; empty when feed omits it
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
		"probability":       ev.Probability,
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

// PublishLiveScore broadcasts a fresh scoreboard payload to every
// browser subscribed to this match's WS channel. ws-gateway forwards
// the JSON verbatim, so the shape matches what the browser already
// reads from the SSR /catalog/matches/:id response. Without this,
// match-list cards stay frozen at whatever `live_score` was when the
// page rendered — markets reprice via the existing odds publisher,
// but scores only landed in Postgres until the next page load.
//
// The payload arg is the same JSON blob that just got written to
// matches.live_score; we reparse it into the wire envelope so the
// browser sees `{type:"score", matchId, liveScore}` and the existing
// useLiveOdds shared-socket dispatcher can route it.
func (b *Bus) PublishLiveScore(ctx context.Context, matchID int64, payload []byte) error {
	if len(payload) == 0 {
		return nil
	}
	var liveScore json.RawMessage = payload
	envelope := struct {
		Type      string          `json:"type"`
		MatchID   string          `json:"matchId"`
		LiveScore json.RawMessage `json:"liveScore"`
	}{
		Type:      "score",
		MatchID:   strconv.FormatInt(matchID, 10),
		LiveScore: liveScore,
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("marshal score envelope: %w", err)
	}
	channel := "odds:match:" + strconv.FormatInt(matchID, 10)
	if err := b.rdb.Publish(ctx, channel, encoded).Err(); err != nil {
		return fmt.Errorf("publish %s: %w", channel, err)
	}
	return nil
}
