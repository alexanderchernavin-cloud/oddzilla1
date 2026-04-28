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
	Probability      string    `json:"probability,omitempty"` // decimal in [0,1]; "" omitted
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
	if err := p.store.UpdateOutcomePublishedOdds(ctx, info.MarketID, ev.OutcomeID, published, ev.Probability, ev.OddinTs); err != nil {
		return err
	}
	if err := p.store.AppendOddsHistoryPublished(ctx, info.MarketID, ev.OutcomeID, ev.RawOdds, published, ev.Probability, time.UnixMilli(ev.OddinTs)); err != nil {
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
		Probability:      ev.Probability,
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

// MinPublishedCents is the floor applied to every published quote in
// cents (1.01). Decimal odds of exactly 1.00 mean "stake back, no
// profit" — useless to the user and refused by the bet slip. Every book
// in the market quotes a minimum of 1.01, so we clamp here to match.
const MinPublishedCents = 101

// applyMargin divides raw decimal odds by (1 + margin_bp/10000) using
// big.Float end-to-end (no float64 intermediate) and floor-truncates to
// 2 decimals. The DB column is NUMERIC(10,4) but the feed and the UI
// both work in 2-decimal precision.
//
// Floor-truncation (not round-half-even) keeps the house conservative:
// we never publish odds HIGHER than the margined price.
//
// Why big.Float end-to-end: a previous implementation routed through
// float64, which corrupted values near 1.00 (e.g. raw 1.01 → stored
// 1.01999...97 → *100 = 100.999...97 → int64 = 100 → displayed 1.00).
// Oddin legitimately sends near-1.00 odds for deeply-in-the-money
// outcomes; the float path turned those into 1.00 displays.
//
// After truncation the result is clamped to MinPublishedCents so a
// displayed 1.00 is never possible regardless of upstream quote.
func applyMargin(rawOdds string, marginBp int) (string, error) {
	if rawOdds == "" {
		return "", fmt.Errorf("empty raw odds")
	}
	raw, ok := new(big.Float).SetPrec(128).SetString(rawOdds)
	if !ok {
		return "", fmt.Errorf("parse raw odds %q", rawOdds)
	}
	divisor := new(big.Float).SetPrec(128).Quo(
		new(big.Float).SetInt64(int64(10000+marginBp)),
		new(big.Float).SetInt64(10000),
	)
	pub := new(big.Float).SetPrec(128).Quo(raw, divisor)
	// Scale to cents and truncate. big.Float.Int truncates toward zero,
	// which equals floor for non-negative inputs.
	scaled := new(big.Float).SetPrec(128).Mul(pub, new(big.Float).SetInt64(100))
	centsBig, _ := scaled.Int(nil)
	cents := centsBig.Int64()
	if cents < MinPublishedCents {
		cents = MinPublishedCents
	}
	return fmt.Sprintf("%d.%02d", cents/100, cents%100), nil
}

// Stats returns a lightweight snapshot used by /healthz.
func (p *Publisher) Stats() (processed, errorsN int64) {
	return p.processed, p.errors
}
