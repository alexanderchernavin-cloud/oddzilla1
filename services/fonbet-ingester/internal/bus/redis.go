// Redis bus adapter — a copy of feed-ingester/internal/bus (per the
// per-service-Go-module rule). `odds.raw` is the stream odds-publisher
// consumes; `odds:match:{id}` is the pub/sub channel ws-gateway fans out to
// browsers. Field names on the stream are the odds-publisher contract and
// must not change (`oddin_ts` is just "source timestamp, ms" for us).

package bus

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const (
	StreamOddsRaw = "odds.raw"
	// MaxLenApprox trims the stream on our XADDs. feed-ingester trims to
	// 100k; a full Fonbet line is ~200k outcomes and a cold start publishes
	// all of them at once, so we keep enough headroom for odds-publisher
	// (batched, thousands of ticks/s) to drain it before anything is cut.
	MaxLenApprox = 400_000
)

// OddsEvent is one outcome update on the stream.
type OddsEvent struct {
	MarketID            int64
	OutcomeID           string
	ProviderMarketID    int
	SpecifiersCanonical string
	RawOdds             string
	Probability         string
	Active              bool
	MatchID             int64
	SourceTs            int64 // ms since epoch; written to the `oddin_ts` field
}

type Bus struct {
	rdb *redis.Client
}

func New(rdb *redis.Client) *Bus {
	return &Bus{rdb: rdb}
}

// PublishOddsBatch pipelines N XADDs in one round trip.
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
				"market_id":          ev.MarketID,
				"outcome_id":         ev.OutcomeID,
				"provider_market_id": ev.ProviderMarketID,
				"specifiers":         ev.SpecifiersCanonical,
				"raw_odds":           ev.RawOdds,
				"probability":        ev.Probability,
				"active":             boolInt(ev.Active),
				"match_id":           ev.MatchID,
				"oddin_ts":           ev.SourceTs,
			},
		})
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("pipeline xadd: %w", err)
	}
	return nil
}

// StreamSettlement is consumed by services/settlement (internal/extstream).
const StreamSettlement = "settlement.external"

// SettlementMessage is one market result handed to the settlement service.
type SettlementMessage struct {
	Type             string // "settle" | "cancel"
	EventURN         string
	ProviderMarketID int
	Specifiers       string // canonical k=v|k=v
	Ts               int64  // ms
	OutcomesJSON     string // JSON array of {id,result,void_factor}; empty for cancel
}

// PublishSettlementBatch XADDs the messages in one pipeline.
func (b *Bus) PublishSettlementBatch(ctx context.Context, msgs []SettlementMessage) error {
	if len(msgs) == 0 {
		return nil
	}
	pipe := b.rdb.Pipeline()
	for _, m := range msgs {
		pipe.XAdd(ctx, &redis.XAddArgs{
			Stream: StreamSettlement,
			MaxLen: 200_000,
			Approx: true,
			Values: map[string]any{
				"type":               m.Type,
				"provider":           "fonbet",
				"event_urn":          m.EventURN,
				"provider_market_id": m.ProviderMarketID,
				"specifiers":         m.Specifiers,
				"ts":                 m.Ts,
				"outcomes":           m.OutcomesJSON,
			},
		})
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("pipeline xadd %s: %w", StreamSettlement, err)
	}
	return nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (b *Bus) publishEnvelope(ctx context.Context, matchID int64, envelope any) error {
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("marshal envelope: %w", err)
	}
	channel := "odds:match:" + strconv.FormatInt(matchID, 10)
	if err := b.rdb.Publish(ctx, channel, encoded).Err(); err != nil {
		return fmt.Errorf("publish %s: %w", channel, err)
	}
	return nil
}

// PublishMarketStatus broadcasts a market-level status change.
func (b *Bus) PublishMarketStatus(ctx context.Context, matchID, marketID int64, status int16, ts int64) error {
	return b.publishEnvelope(ctx, matchID, struct {
		Type     string `json:"type"`
		MatchID  string `json:"matchId"`
		MarketID string `json:"marketId"`
		Status   int16  `json:"status"`
		Ts       int64  `json:"ts"`
	}{"marketStatus", strconv.FormatInt(matchID, 10), strconv.FormatInt(marketID, 10), status, ts})
}

// PublishMatchStatus broadcasts a match lifecycle transition.
func (b *Bus) PublishMatchStatus(ctx context.Context, matchID int64, status string, ts int64) error {
	return b.publishEnvelope(ctx, matchID, struct {
		Type    string `json:"type"`
		MatchID string `json:"matchId"`
		Status  string `json:"status"`
		Ts      int64  `json:"ts"`
	}{"matchStatus", strconv.FormatInt(matchID, 10), status, ts})
}

// PublishLiveScore broadcasts the scoreboard payload just written to
// matches.live_score.
func (b *Bus) PublishLiveScore(ctx context.Context, matchID int64, payload []byte) error {
	if len(payload) == 0 {
		return nil
	}
	return b.publishEnvelope(ctx, matchID, struct {
		Type      string          `json:"type"`
		MatchID   string          `json:"matchId"`
		LiveScore json.RawMessage `json:"liveScore"`
	}{"score", strconv.FormatInt(matchID, 10), json.RawMessage(payload)})
}
