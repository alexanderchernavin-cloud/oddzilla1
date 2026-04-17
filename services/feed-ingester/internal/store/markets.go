package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MarketKey uniquely identifies a market in our DB via the natural 3-tuple.
type MarketKey struct {
	MatchID          int64
	ProviderMarketID int
	SpecifiersHash   []byte
}

// MarketUpsert carries everything needed to upsert one row into `markets`.
type MarketUpsert struct {
	Key             MarketKey
	SpecifiersJSON  map[string]string // canonical key→value map
	Status          int16
	LastOddinTs     int64
}

// OutcomeUpsert carries a single outcome row.
type OutcomeUpsert struct {
	MarketID      int64
	OutcomeID     string
	Name          string
	RawOdds       *string // decimal as string; nil → don't touch
	Active        bool
	LastOddinTs   int64
}

// UpsertMarket inserts a market row or updates its status + last_oddin_ts,
// returning the id. The unique key is (match_id, provider_market_id,
// specifiers_hash). We do NOT overwrite specifiers_json on update — the
// canonical form is fixed by the key, so changing it would be a bug.
func UpsertMarket(ctx context.Context, db pgxRunner, m MarketUpsert) (int64, error) {
	specBytes, err := json.Marshal(m.SpecifiersJSON)
	if err != nil {
		return 0, fmt.Errorf("marshal specifiers: %w", err)
	}
	const q = `
INSERT INTO markets (match_id, provider_market_id, specifiers_json, specifiers_hash, status, last_oddin_ts, updated_at)
VALUES ($1, $2, $3::jsonb, $4, $5, $6, NOW())
ON CONFLICT (match_id, provider_market_id, specifiers_hash) DO UPDATE
   SET status        = EXCLUDED.status,
       last_oddin_ts = GREATEST(markets.last_oddin_ts, EXCLUDED.last_oddin_ts),
       updated_at    = NOW()
RETURNING id
`
	var id int64
	err = db.QueryRow(ctx, q,
		m.Key.MatchID, m.Key.ProviderMarketID, string(specBytes),
		m.Key.SpecifiersHash, int(m.Status), m.LastOddinTs,
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("upsert market: %w", err)
	}
	return id, nil
}

// UpsertOutcomes upserts a batch of outcome rows for a single market. Only
// touches raw_odds/active/last_oddin_ts; published_odds + result are
// managed by odds-publisher and settlement workers respectively.
func UpsertOutcomes(ctx context.Context, db pgxRunner, rows []OutcomeUpsert) error {
	if len(rows) == 0 {
		return nil
	}
	// Build a VALUES list. pgx supports batch inserts via CopyFrom, but
	// COPY with ON CONFLICT requires a staging table; for the Phase 3
	// volume (dozens per market-change) a simple multi-row INSERT is fine.
	const q = `
INSERT INTO market_outcomes
  (market_id, outcome_id, name, raw_odds, active, last_oddin_ts, updated_at)
VALUES ($1, $2, $3, $4::numeric, $5, $6, NOW())
ON CONFLICT (market_id, outcome_id) DO UPDATE
   SET raw_odds      = COALESCE(EXCLUDED.raw_odds, market_outcomes.raw_odds),
       active        = EXCLUDED.active,
       name          = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE market_outcomes.name END,
       last_oddin_ts = GREATEST(market_outcomes.last_oddin_ts, EXCLUDED.last_oddin_ts),
       updated_at    = NOW()
`
	// Execute one-by-one inside a single batch. pgx batch is efficient — a
	// single roundtrip for the whole group.
	batch := &pgx.Batch{}
	for _, r := range rows {
		var rawOdds any
		if r.RawOdds != nil {
			rawOdds = *r.RawOdds
		}
		name := r.Name
		batch.Queue(q, r.MarketID, r.OutcomeID, name, rawOdds, r.Active, r.LastOddinTs)
	}
	br := db.SendBatch(ctx, batch)
	defer br.Close()
	for i := 0; i < len(rows); i++ {
		if _, err := br.Exec(); err != nil {
			return fmt.Errorf("upsert outcome[%d]: %w", i, err)
		}
	}
	return nil
}

// AppendOddsHistory batch-inserts odds_history rows. Ignores duplicates at
// the natural no-constraint level — ts is always "now" so duplicates are
// rare and the table is append-only; we accept them rather than add a
// constraint that would slow inserts.
func AppendOddsHistory(ctx context.Context, db pgxRunner, rows []OddsHistoryRow) error {
	if len(rows) == 0 {
		return nil
	}
	cols := []string{"market_id", "outcome_id", "raw_odds", "published_odds", "ts"}
	src := make([][]any, len(rows))
	for i, r := range rows {
		var rawOdds, pubOdds any
		if r.RawOdds != nil {
			rawOdds = *r.RawOdds
		}
		if r.PublishedOdds != nil {
			pubOdds = *r.PublishedOdds
		}
		src[i] = []any{r.MarketID, r.OutcomeID, rawOdds, pubOdds, r.Ts}
	}
	// Use CopyFrom where available (pgxpool exposes it via Acquire).
	if p, ok := db.(*pgxpool.Pool); ok {
		conn, err := p.Acquire(ctx)
		if err != nil {
			return fmt.Errorf("acquire conn: %w", err)
		}
		defer conn.Release()
		_, err = conn.CopyFrom(ctx, pgx.Identifier{"odds_history"}, cols, pgx.CopyFromRows(src))
		if err != nil {
			return fmt.Errorf("copy odds_history: %w", err)
		}
		return nil
	}
	// Fallback: multi-row insert via batch.
	batch := &pgx.Batch{}
	const q = `
INSERT INTO odds_history (market_id, outcome_id, raw_odds, published_odds, ts)
VALUES ($1, $2, $3::numeric, $4::numeric, $5)
`
	for _, v := range src {
		batch.Queue(q, v...)
	}
	br := db.SendBatch(ctx, batch)
	defer br.Close()
	for i := 0; i < len(rows); i++ {
		if _, err := br.Exec(); err != nil {
			return fmt.Errorf("insert odds_history[%d]: %w", i, err)
		}
	}
	return nil
}

// OddsHistoryRow is the append-only odds snapshot written by the ingester
// (raw_odds only; published_odds is filled by odds-publisher later).
type OddsHistoryRow struct {
	MarketID      int64
	OutcomeID     string
	RawOdds       *string // decimal string
	PublishedOdds *string
	Ts            time.Time
}

// pgxRunner is the subset of pgx APIs both pgxpool.Pool and pgx.Tx satisfy.
type pgxRunner interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	SendBatch(ctx context.Context, b *pgx.Batch) pgx.BatchResults
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}
