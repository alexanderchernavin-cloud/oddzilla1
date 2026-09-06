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
	"strconv"
	"strings"
	"sync/atomic"
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
//
// `SportID` + `TournamentID` are carried so per-bettor odds adjustment can
// resolve the cascade (match > tournament > sport > global) in ws-gateway
// without a separate DB lookup per match. The fields are additive — older
// consumers (e.g. the storefront's `use-live-odds` hook) ignore unknown
// keys.
type OutboundPayload struct {
	Type             string    `json:"type"` // always "odds"
	MatchID          int64     `json:"matchId,string"`
	MarketID         int64     `json:"marketId,string"`
	ProviderMarketID int       `json:"providerMarketId"`
	SportID          int       `json:"sportId"`
	TournamentID     int       `json:"tournamentId"`
	Specifiers       string    `json:"specifiers"` // canonical k=v|k=v
	OutcomeID        string    `json:"outcomeId"`
	PublishedOdds    string    `json:"publishedOdds"`         // decimal string
	Probability      string    `json:"probability,omitempty"` // decimal in [0,1]; "" omitted
	Active           bool      `json:"active"`
	Ts               time.Time `json:"ts"`
}

type Publisher struct {
	store    *store.Store
	rdb      *redis.Client
	cacheTTL time.Duration
	log      zerolog.Logger

	// historySkipPMIDMin > 0 drops the odds_history INSERT for ticks whose
	// provider_market_id is at or above it (published_odds still updates).
	// Operator brake on odds_history growth for a high-churn provider;
	// see config.HistorySkipPMIDMin.
	historySkipPMIDMin int

	// Counters for healthz/metrics. Atomic so the /healthz handler
	// can read them from a different goroutine than Handle
	// without `go test -race` firing.
	processed atomic.Int64
	errors    atomic.Int64
}

func New(st *store.Store, rdb *redis.Client, cacheTTL time.Duration, historySkipPMIDMin int, log zerolog.Logger) *Publisher {
	if historySkipPMIDMin > 0 {
		log.Warn().Int("provider_market_id_min", historySkipPMIDMin).
			Msg("odds_history disabled for ticks at or above this provider_market_id (ODDS_HISTORY_SKIP_PMID_MIN)")
	}
	return &Publisher{
		store:              st,
		rdb:                rdb,
		cacheTTL:           cacheTTL,
		historySkipPMIDMin: historySkipPMIDMin,
		log:                log.With().Str("component", "publisher").Logger(),
	}
}

// Handle implements bus.Handler. Resolves market metadata + margin for
// every event in the batch, then persists the whole batch with one UPDATE
// and one odds_history INSERT before fanning out one PUBLISH per event.
//
// Batched on purpose: the previous one-event-at-a-time loop cost two
// Postgres round-trips per tick and topped out at a few hundred ticks per
// second — enough for Oddin's esports volume, not for a second provider
// (Fonbet, ~200k priced outcomes) sharing the stream. Semantics are
// unchanged: same margin math, same DISTINCT guards, same payload.
func (p *Publisher) Handle(ctx context.Context, events []bus.Event) error {
	if len(events) == 0 {
		return nil
	}

	type prepared struct {
		row     store.PublishedRow
		payload OutboundPayload
	}
	// Resolve every distinct market of the batch in one round-trip (cache
	// hits are served from the LRU, misses are fetched together).
	ids := make([]int64, 0, len(events))
	seen := make(map[int64]struct{}, len(events))
	for _, ev := range events {
		if _, ok := seen[ev.MarketID]; !ok {
			seen[ev.MarketID] = struct{}{}
			ids = append(ids, ev.MarketID)
		}
	}
	infos, err := p.store.ResolveMarkets(ctx, ids)
	if err != nil {
		p.errors.Add(int64(len(events)))
		return fmt.Errorf("resolve markets: %w", err)
	}

	items := make([]prepared, 0, len(events))
	for _, ev := range events {
		info, ok := infos[ev.MarketID]
		if !ok {
			p.fail(ev, fmt.Errorf("market %d not found (race with ingester?)", ev.MarketID))
			continue
		}
		marginBp, err := p.store.CurrentMargin(ctx, info, p.cacheTTL)
		if err != nil {
			p.fail(ev, fmt.Errorf("margin: %w", err))
			continue
		}
		published, err := applyMargin(ev.RawOdds, marginBp)
		if err != nil {
			p.fail(ev, fmt.Errorf("apply margin: %w", err))
			continue
		}
		items = append(items, prepared{
			row: store.PublishedRow{
				MarketID: info.MarketID, OutcomeID: ev.OutcomeID, RawOdds: ev.RawOdds,
				PublishedOdds: published, Probability: ev.Probability, SourceTs: ev.OddinTs,
			},
			payload: OutboundPayload{
				Type:             "odds",
				MatchID:          info.MatchID,
				MarketID:         info.MarketID,
				ProviderMarketID: info.ProviderMarketID,
				SportID:          info.SportID,
				TournamentID:     info.TournamentID,
				Specifiers:       ev.SpecifiersCanonical,
				OutcomeID:        ev.OutcomeID,
				PublishedOdds:    published,
				Probability:      ev.Probability,
				Active:           ev.Active,
				Ts:               time.UnixMilli(ev.OddinTs),
			},
		})
	}
	if len(items) == 0 {
		return nil
	}

	// One row per (market, outcome) for the UPDATE — the stream is ordered,
	// so the last tick in the batch is the current price. History keeps
	// every tick.
	type outcomeKey struct {
		marketID  int64
		outcomeID string
	}
	latest := make(map[outcomeKey]int, len(items))
	for i, it := range items {
		latest[outcomeKey{it.row.MarketID, it.row.OutcomeID}] = i
	}
	rows := make([]store.PublishedRow, 0, len(latest))
	history := make([]store.PublishedRow, 0, len(items))
	for i, it := range items {
		if latest[outcomeKey{it.row.MarketID, it.row.OutcomeID}] == i {
			rows = append(rows, it.row)
		}
		if p.historySkipPMIDMin > 0 && it.payload.ProviderMarketID >= p.historySkipPMIDMin {
			continue // operator brake: no odds_history for this provider range
		}
		history = append(history, it.row)
	}

	// Persist first so reconnecting WS clients see the truth. A failed
	// batch write falls back to per-row writes so one row Postgres rejects
	// cannot poison the whole batch (the pre-batch loop isolated failures
	// per event; keep that contract). Rows that still fail are dropped
	// like a failed single tick used to be — downstream catches up on the
	// next price move.
	if err := p.store.UpdateOutcomesPublishedBulk(ctx, rows); err != nil {
		p.log.Warn().Err(err).Int("rows", len(rows)).Msg("batch publish write failed; retrying per row")
		for _, r := range rows {
			if rerr := p.store.UpdateOutcomesPublishedBulk(ctx, []store.PublishedRow{r}); rerr != nil {
				p.errors.Add(1)
				p.log.Warn().Err(rerr).Int64("market", r.MarketID).Str("outcome", r.OutcomeID).Msg("publish write failed; tick dropped")
			}
		}
	}
	if err := p.store.AppendOddsHistoryPublishedBulk(ctx, history); err != nil {
		// Not fatal — history is for audit, not correctness.
		p.log.Debug().Err(err).Msg("history insert failed")
	}

	// Fan out. Pipelined; pub/sub drops are tolerable — the DB write is
	// the source of truth.
	pipe := p.rdb.Pipeline()
	for _, it := range items {
		body, err := json.Marshal(it.payload)
		if err != nil {
			p.log.Warn().Err(err).Msg("marshal payload")
			continue
		}
		pipe.Publish(ctx, PubChannelPrefix+strconv.FormatInt(it.payload.MatchID, 10), body)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		p.log.Debug().Err(err).Msg("publish failed (best-effort)")
	}
	p.processed.Add(int64(len(items)))
	return nil
}

// fail records a per-event failure without short-circuiting the batch:
// the bus consumer XACKs the whole batch regardless, so a bad event means
// we drop one odds tick and downstream catches up on the next one.
func (p *Publisher) fail(ev bus.Event, err error) {
	p.log.Warn().Err(err).Int64("market", ev.MarketID).Str("outcome", ev.OutcomeID).Msg("process failed")
	p.errors.Add(1)
}

// applyMargin divides raw decimal odds by (1 + margin_bp/10000) using
// big.Float end-to-end (no float64 intermediate) and renders the result
// at the storage column's NUMERIC(10,4) precision with trailing zeros
// trimmed down to a 2-decimal minimum.
//
// Output shape: minimum 2dp, maximum 4dp, no trailing zeros above 2dp.
// "1.5000"→"1.50", "1.0030"→"1.003", "1.5034"→"1.5034". This mirrors
// what Oddin sends (typically 2-3dp) instead of forcing a 2dp display
// that rounds 1.003 → 1.00.
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
// No low-side floor — display whatever Oddin sends. Decimal odds of 1.00
// (stake back, no profit) are legitimate quotes for deeply-in-the-money
// outcomes and we surface them honestly.
func applyMargin(rawOdds string, marginBp int) (string, error) {
	if rawOdds == "" {
		return "", fmt.Errorf("empty raw odds")
	}
	raw, ok := new(big.Float).SetPrec(128).SetString(rawOdds)
	if !ok {
		return "", fmt.Errorf("parse raw odds %q", rawOdds)
	}
	if marginBp == 0 {
		// Pass-through: no division needed. Re-render at the
		// canonical shape so DB NUMERIC(10,4) round-trips don't
		// reintroduce trailing zeros downstream.
		return formatPublishedOdds(raw), nil
	}
	divisor := new(big.Float).SetPrec(128).Quo(
		new(big.Float).SetInt64(int64(10000+marginBp)),
		new(big.Float).SetInt64(10000),
	)
	pub := new(big.Float).SetPrec(128).Quo(raw, divisor)
	return formatPublishedOdds(pub), nil
}

// ladderUnits snaps a price DOWN onto the quote ladder, working in units
// of 1e-4 (the NUMERIC(10,4) grid) so the arithmetic is exact integer
// division with no float dust to guard against.
//
// This is where the ladder is applied for the whole system: the string
// this file produces IS `market_outcomes.published_odds`, so every
// downstream reader — the catalog payload, the storefront, the WS tick,
// the drift reference, and `ticket_selections.odds_at_placement` — sees a
// price already on a rung. The TS and Go format twins ladder again for
// their own inputs (a per-bettor adjustment multiplies off the rungs),
// which is idempotent here.
//
// Bands mirror LADDER_BANDS in packages/types/src/odds.ts:
// 0.01 below 10, then 0.1 / 0.5 / 1 / 5 as the price lengthens. Prices
// under 1.01 keep full precision — the ladder has no rung between an
// unbettable 1.00 and a 1.01 that is longer than the feed said, and a
// genuine 1.003 favorite must survive intact.
//
// Non-positive values (reachable when a non-zero payback_margin_bp
// divides a near-1.0 price below 1.0 — publisher_test.go pins 1.003 at
// 5% margin to 0.9552) fall under the floor and pass through untouched.
func ladderUnits(units int64) int64 {
	const floorUnits = 10100 // 1.01
	if units < floorUnits {
		return units
	}
	var step int64
	switch {
	case units < 100000: // < 10
		step = 100 // 0.01
	case units < 200000: // < 20
		step = 1000 // 0.1
	case units < 500000: // < 50
		step = 5000 // 0.5
	case units < 1000000: // < 100
		step = 10000 // 1
	default:
		step = 50000 // 5
	}
	return (units / step) * step
}

// formatPublishedOdds renders a big.Float at NUMERIC(10,4) precision
// (4 fractional digits, floor-truncated — same toward-zero convention
// big.Float.Int uses for non-negative values) then trims trailing zeros
// down to a 2dp minimum. Shared shape with the TS formatOdds and the
// Go drift-worker formatter so every layer in the pipeline produces
// byte-identical strings.
//
// epsilon nudge: SetString("1.0034") at 128-bit precision can round
// SLIGHTLY below the target ("1.00339999...e"); multiplied by 10000
// that becomes 10033.9999..., which Int floors to 10033 → "1.0033".
// A 1e-6 nudge on the scaled value (≈1e-10 in raw odds) absorbs this
// without crossing any real threshold — NUMERIC(10,4) only resolves to
// 1e-4. Same trick the TS and drift-worker formatters use.
func formatPublishedOdds(v *big.Float) string {
	scaled := new(big.Float).SetPrec(128).Mul(v, new(big.Float).SetInt64(10000))
	scaled = new(big.Float).SetPrec(128).Add(scaled, big.NewFloat(1e-6))
	unitsBig, _ := scaled.Int(nil)
	units := ladderUnits(unitsBig.Int64())
	intP := units / 10000
	frac := units % 10000
	s := fmt.Sprintf("%d.%04d", intP, frac)
	for strings.HasSuffix(s, "0") {
		dot := strings.IndexByte(s, '.')
		if dot < 0 || len(s)-1-dot <= 2 {
			break
		}
		s = s[:len(s)-1]
	}
	return s
}

// Stats returns a lightweight snapshot used by /healthz.
func (p *Publisher) Stats() (processed, errorsN int64) {
	return p.processed.Load(), p.errors.Load()
}
