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
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	StreamOddsRaw = "odds.raw"
	// MaxLenApprox trims the stream on our XADDs. MUST equal
	// feed-ingester's value — MAXLEN is applied by whichever producer's
	// XADD runs, so the two would otherwise fight. A full Fonbet line is
	// ~200k outcomes and a cold start publishes all of them; that burst is
	// handled by backpressure on the consumer group's lag (OddsBacklog,
	// used by ingest.flush), NOT by raising this cap: production Redis is
	// maxmemory 256mb + allkeys-lru, and a stream that outgrows the budget
	// evicts unrelated keys and destroys consumer groups (2026-09-03).
	MaxLenApprox = 100_000
	// SettlementMaxLenApprox bounds settlement.external. One settlement
	// pass emits at most a few thousand entries and the consumer acks
	// within milliseconds; 20k covers a long consumer outage (~6 MB) and
	// the ingester re-emits anything older than an hour from Postgres
	// state anyway (settle.Worker), so nothing is lost when this trims.
	SettlementMaxLenApprox = 20_000
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
	// oddsGroup is odds-publisher's consumer group on odds.raw
	// (ODDS_PUBLISHER_GROUP); OddsBacklog reads its lag for backpressure.
	oddsGroup string
}

func New(rdb *redis.Client, oddsGroup string) *Bus {
	return &Bus{rdb: rdb, oddsGroup: oddsGroup}
}

// OddsBacklog returns how many odds.raw entries odds-publisher has not yet
// finished with (undelivered lag + delivered-but-unacked pending) and ok
// when the number is trustworthy. ok=false when the group does not exist
// yet, XINFO fails, or Redis cannot compute the lag (it reports nil after
// certain trims); callers must then publish without backpressure rather
// than stall — the stream's MAXLEN is still the hard ceiling.
func (b *Bus) OddsBacklog(ctx context.Context) (int64, bool) {
	if b.oddsGroup == "" {
		return 0, false
	}
	groups, err := b.rdb.XInfoGroups(ctx, StreamOddsRaw).Result()
	if err != nil {
		return 0, false
	}
	for _, g := range groups {
		if g.Name != b.oddsGroup {
			continue
		}
		// go-redis surfaces a nil lag as 0 with no way to tell it apart
		// from a genuine 0; with EntriesRead also 0 nothing has ever been
		// delivered and the lag is real, otherwise treat 0 lag + 0 pending
		// as "drained" — the only wrong answer is a false positive, which
		// stalls the producer, and that is bounded by the caller's wait cap.
		return g.Lag + g.Pending, true
	}
	return 0, false
}

// StatusKey is the Redis hash the backoffice reads for the "Fonbet feed"
// card on /admin/feed (GET /admin/feed/fonbet-status). Refreshed every few
// seconds with a TTL so a dead service reads as offline rather than frozen.
// A cache, not state: the operator's switch position lives in Postgres
// (feed_control), this only reports what the service is doing.
const (
	StatusKey = "fonbet:feed:status"
	statusTTL = 120 * time.Second
)

// WriteStatus HSETs the status fields and refreshes the TTL in one
// transaction.
func (b *Bus) WriteStatus(ctx context.Context, fields map[string]any) error {
	pipe := b.rdb.TxPipeline()
	pipe.HSet(ctx, StatusKey, fields)
	pipe.Expire(ctx, StatusKey, statusTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("status hset: %w", err)
	}
	return nil
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
			MaxLen: SettlementMaxLenApprox,
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

// StatusFrame is one market-level status change to broadcast.
type StatusFrame struct {
	MatchID  int64
	MarketID int64
	Status   int16
}

// PublishMarketStatusBatch broadcasts market-level status changes,
// pipelined: a full-catalog suspend produces ~90k frames and one PUBLISH
// round-trip each would not fit the shutdown budget.
func (b *Bus) PublishMarketStatusBatch(ctx context.Context, frames []StatusFrame, ts int64) error {
	const chunk = 1000
	for i := 0; i < len(frames); i += chunk {
		end := min(i+chunk, len(frames))
		pipe := b.rdb.Pipeline()
		for _, f := range frames[i:end] {
			encoded, err := json.Marshal(struct {
				Type     string `json:"type"`
				MatchID  string `json:"matchId"`
				MarketID string `json:"marketId"`
				Status   int16  `json:"status"`
				Ts       int64  `json:"ts"`
			}{"marketStatus", strconv.FormatInt(f.MatchID, 10), strconv.FormatInt(f.MarketID, 10), f.Status, ts})
			if err != nil {
				return fmt.Errorf("marshal marketStatus: %w", err)
			}
			pipe.Publish(ctx, "odds:match:"+strconv.FormatInt(f.MatchID, 10), encoded)
		}
		if _, err := pipe.Exec(ctx); err != nil {
			return fmt.Errorf("pipeline publish marketStatus: %w", err)
		}
	}
	return nil
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
