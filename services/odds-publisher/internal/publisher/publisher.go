// Core publisher: consume odds.raw events, apply margin, write
// published_odds to Postgres, fan out to Redis pub/sub channel
// `odds:match:{id}` for the ws-gateway.
//
// Margin math (decimal odds):
//   The "payback margin" is the % the book keeps per 100% of implied
//   probability. Raw decimal odds are converted to implied probability
//   (p = 1/odds), the book multiplier applied, then back to odds:
//     pub_odds = raw_odds / (1 + margin_bp/10000)
//   For a 5% margin (500 bp): 2.00 → 1.905
//
// We use a simple division rather than redistributing across all outcomes
// in a market because the ingester hands us one outcome at a time and we
// don't have atomic visibility into the full market here. The 5% margin
// applied uniformly is the industry-standard first-cut; per-outcome
// overround shifting can be added in a future phase.

package publisher

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"

	"github.com/oddzilla/odds-publisher/internal/bus"
	"github.com/oddzilla/odds-publisher/internal/store"
)

const (
	// PubChannelPrefix + match id → Redis pub/sub channel name.
	PubChannelPrefix = "odds:match:"
)

// OutboundPayload is what ws-gateway subscribers see. Kept small.
type OutboundPayload struct {
	Type             string    `json:"type"` // always "odds"
	MatchID          int64     `json:"matchId,string"`
	MarketID         int64     `json:"marketId,string"`
	ProviderMarketID int       `json:"providerMarketId"`
	Specifiers       string    `json:"specifiers"` // canonical k=v|k=v
	OutcomeID        string    `json:"outcomeId"`
	PublishedOdds    string    `json:"publishedOdds"` // decimal string
	Active           bool      `json:"active"`
	Ts               time.Time `json:"ts"`
}

type Publisher struct {
	store      *store.Store
	rdb        *redis.Client
	cacheTTL   time.Duration
	log        zerolog.Logger

	// Counters for healthz/metrics. Not atomic — read is best-effort.
	processed int64
	errors    int64
}

func New(st *store.Store, rdb *redis.Client, cacheTTL time.Duration, log zerolog.Logger) *Publisher {
	return &Publisher{
		store:    st,
		rdb:      rdb,
		cacheTTL: cacheTTL,
		log:      log.With().Str("component", "publisher").Logger(),
	}
}

// Handle implements bus.Handler. Processes a batch in parallel-safe
// sequential order: for each event, look up the market, fetch margin,
// compute published odds, persist, then PUBLISH.
func (p *Publisher) Handle(ctx context.Context, events []bus.Event) error {
	if len(events) == 0 {
		return nil
	}

	for _, ev := range events {
		if err := p.processOne(ctx, ev); err != nil {
			p.log.Warn().Err(err).Int64("market", ev.MarketID).Str("outcome", ev.OutcomeID).Msg("process failed")
			p.errors++
			// Don't short-circuit — other events in the batch should
			// still process. Errors keep the entry pending for retry
			// via claim.
		} else {
			p.processed++
		}
	}
	return nil
}

func (p *Publisher) processOne(ctx context.Context, ev bus.Event) error {
	info, err := p.store.ResolveMarket(ctx, ev.MarketID)
	if err != nil {
		return fmt.Errorf("resolve: %w", err)
	}
	marginBp, err := p.store.CurrentMargin(ctx, info, p.cacheTTL)
	if err != nil {
		return fmt.Errorf("margin: %w", err)
	}

	published, err := applyMargin(ev.RawOdds, marginBp)
	if err != nil {
		return fmt.Errorf("apply margin: %w", err)
	}

	// Persist first so reconnecting WS clients see the truth.
	if err := p.store.UpdateOutcomePublishedOdds(ctx, info.MarketID, ev.OutcomeID, published, ev.OddinTs); err != nil {
		return err
	}
	if err := p.store.AppendOddsHistoryPublished(ctx, info.MarketID, ev.OutcomeID, ev.RawOdds, published, time.UnixMilli(ev.OddinTs)); err != nil {
		// Not fatal — history is for audit, not correctness.
		p.log.Debug().Err(err).Msg("history insert failed")
	}

	// Fan out.
	payload := OutboundPayload{
		Type:             "odds",
		MatchID:          info.MatchID,
		MarketID:         info.MarketID,
		ProviderMarketID: info.ProviderMarketID,
		Specifiers:       ev.SpecifiersCanonical,
		OutcomeID:        ev.OutcomeID,
		PublishedOdds:    published,
		Active:           ev.Active,
		Ts:               time.UnixMilli(ev.OddinTs),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}
	channel := PubChannelPrefix + fmt.Sprintf("%d", info.MatchID)
	if err := p.rdb.Publish(ctx, channel, body).Err(); err != nil {
		// Pub/sub drops are tolerable — the DB write is the source of truth.
		p.log.Debug().Err(err).Str("channel", channel).Msg("publish failed (best-effort)")
	}
	return nil
}

// applyMargin divides raw decimal odds by (1 + margin_bp/10000) using
// big.Float for precision. Returns the result as a 2-decimal string —
// the industry-standard display precision for decimal odds. The DB
// column is NUMERIC(10,4) (kept for backward compatibility and history
// rows ingested before this change); Postgres will store e.g. 3.14 as
// 3.1400, and the API layer trims the trailing zeros for the client.
//
// Floor-round (via math truncation by Sprintf) so we never publish odds
// HIGHER than the margined price — users get the conservative quote and
// payouts don't exceed what the book mathematically collected for.
func applyMargin(rawOdds string, marginBp int) (string, error) {
	if rawOdds == "" {
		return "", fmt.Errorf("empty raw odds")
	}
	raw, ok := new(big.Float).SetPrec(64).SetString(rawOdds)
	if !ok {
		return "", fmt.Errorf("parse raw odds %q", rawOdds)
	}
	divisor := new(big.Float).Quo(
		new(big.Float).SetInt64(int64(10000+marginBp)),
		big.NewFloat(10000),
	)
	pub := new(big.Float).Quo(raw, divisor)
	pubF, _ := pub.Float64()
	// Truncate to 2 decimals (floor, not round-half-even) by multiplying,
	// flooring, dividing. fmt %f rounds, so we can't use it directly.
	truncated := float64(int64(pubF*100)) / 100.0
	return fmt.Sprintf("%.2f", truncated), nil
}

// Stats returns a lightweight snapshot used by /healthz.
func (p *Publisher) Stats() (processed, errorsN int64) {
	return p.processed, p.errors
}
