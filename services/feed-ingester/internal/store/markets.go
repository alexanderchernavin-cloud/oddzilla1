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
	Probability   *string // decimal in [0,1]; nil → don't touch
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
  (market_id, outcome_id, name, raw_odds, probability, active, last_oddin_ts, updated_at)
VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6, $7, NOW())
ON CONFLICT (market_id, outcome_id) DO UPDATE
   SET raw_odds      = COALESCE(EXCLUDED.raw_odds, market_outcomes.raw_odds),
       probability   = COALESCE(EXCLUDED.probability, market_outcomes.probability),
       active        = EXCLUDED.active,
       name          = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE market_outcomes.name END,
       last_oddin_ts = GREATEST(market_outcomes.last_oddin_ts, EXCLUDED.last_oddin_ts),
       updated_at    = NOW()
`
	// Execute one-by-one inside a single batch. pgx batch is efficient — a
	// single roundtrip for the whole group.
	batch := &pgx.Batch{}
	for _, r := range rows {
		var rawOdds, probability any
		if r.RawOdds != nil {
			rawOdds = *r.RawOdds
		}
		if r.Probability != nil {
			probability = *r.Probability
		}
		name := r.Name
		batch.Queue(q, r.MarketID, r.OutcomeID, name, rawOdds, probability, r.Active, r.LastOddinTs)
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
	cols := []string{"market_id", "outcome_id", "raw_odds", "published_odds", "probability", "ts"}
	src := make([][]any, len(rows))
	for i, r := range rows {
		var rawOdds, pubOdds, probability any
		if r.RawOdds != nil {
			rawOdds = *r.RawOdds
		}
		if r.PublishedOdds != nil {
			pubOdds = *r.PublishedOdds
		}
		if r.Probability != nil {
			probability = *r.Probability
		}
		src[i] = []any{r.MarketID, r.OutcomeID, rawOdds, pubOdds, probability, r.Ts}
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
INSERT INTO odds_history (market_id, outcome_id, raw_odds, published_odds, probability, ts)
VALUES ($1, $2, $3::numeric, $4::numeric, $5::numeric, $6)
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
	Probability   *string // decimal in [0,1]; nil when feed omits it
	Ts            time.Time
}

// pgxRunner is the subset of pgx APIs both pgxpool.Pool and pgx.Tx satisfy.
type pgxRunner interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	SendBatch(ctx context.Context, b *pgx.Batch) pgx.BatchResults
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// ─── Bulk upserts (audit H7) ───────────────────────────────────────────────
//
// The single-row variants above are kept because tests and a handful of
// REST-driven paths still call them. The handler hot path
// (handleOddsChange) now uses the *Bulk variants so one odds_change
// message produces 3 round-trips total (markets + outcomes + history),
// regardless of how many markets the message touches.

// MarketUpsertBulkResult maps the natural market key back to the id
// assigned (or already held) by the markets table. Bulk callers use
// this to attach outcomes/history rows to the right market_id without
// a second SELECT round-trip.
type MarketUpsertBulkResult struct {
	ProviderMarketID int
	SpecifiersHash   []byte
	ID               int64
}

// UpsertMarketsBulk performs a single UNNEST-based INSERT for every
// market in `markets`, mirroring the single-row UpsertMarket semantics:
// ON CONFLICT on the natural 3-tuple keeps id stable, bumps status and
// last_oddin_ts (the latter monotonically). RETURNING + the input row's
// provider_market_id + specifiers_hash lets the caller rebuild the
// map[(providerMarketID, hash)] → id without a follow-up query.
//
// All markets in one call must share the same match_id (handleOddsChange
// only ever calls this for a single match). That keeps the SQL signature
// flat — match_id is a scalar arg, not an array.
func UpsertMarketsBulk(ctx context.Context, db pgxRunner, matchID int64, markets []MarketUpsert) ([]MarketUpsertBulkResult, error) {
	if len(markets) == 0 {
		return nil, nil
	}
	providerIDs := make([]int32, len(markets))
	specJSONs := make([]string, len(markets))
	specHashes := make([][]byte, len(markets))
	statuses := make([]int32, len(markets))
	lastTs := make([]int64, len(markets))
	for i, m := range markets {
		providerIDs[i] = int32(m.Key.ProviderMarketID)
		jb, err := json.Marshal(m.SpecifiersJSON)
		if err != nil {
			return nil, fmt.Errorf("marshal specifiers[%d]: %w", i, err)
		}
		specJSONs[i] = string(jb)
		specHashes[i] = m.Key.SpecifiersHash
		statuses[i] = int32(m.Status)
		lastTs[i] = m.LastOddinTs
	}

	const q = `
INSERT INTO markets
  (match_id, provider_market_id, specifiers_json, specifiers_hash, status, last_oddin_ts, updated_at)
SELECT $1, t.pmid, t.spec::jsonb, t.hash, t.status, t.lts, NOW()
  FROM UNNEST($2::int[], $3::text[], $4::bytea[], $5::int[], $6::bigint[])
       AS t(pmid, spec, hash, status, lts)
ON CONFLICT (match_id, provider_market_id, specifiers_hash) DO UPDATE
   SET status        = EXCLUDED.status,
       last_oddin_ts = GREATEST(markets.last_oddin_ts, EXCLUDED.last_oddin_ts),
       updated_at    = NOW()
RETURNING id, provider_market_id, specifiers_hash`
	rows, err := db.Query(ctx, q, matchID, providerIDs, specJSONs, specHashes, statuses, lastTs)
	if err != nil {
		return nil, fmt.Errorf("upsert markets bulk: %w", err)
	}
	defer rows.Close()
	out := make([]MarketUpsertBulkResult, 0, len(markets))
	for rows.Next() {
		var r MarketUpsertBulkResult
		var pmid int32
		if err := rows.Scan(&r.ID, &pmid, &r.SpecifiersHash); err != nil {
			return nil, fmt.Errorf("scan upsert markets bulk: %w", err)
		}
		r.ProviderMarketID = int(pmid)
		out = append(out, r)
	}
	return out, rows.Err()
}

// UpsertOutcomesBulk applies every outcome row in one UNNEST INSERT.
// Replaces the per-market pgx.Batch loop with a single round-trip; the
// ON CONFLICT semantics are identical to the single-call UpsertOutcomes.
func UpsertOutcomesBulk(ctx context.Context, db pgxRunner, rows []OutcomeUpsert) error {
	if len(rows) == 0 {
		return nil
	}
	marketIDs := make([]int64, len(rows))
	outcomeIDs := make([]string, len(rows))
	names := make([]string, len(rows))
	rawOdds := make([]*string, len(rows))
	probs := make([]*string, len(rows))
	actives := make([]bool, len(rows))
	lastTs := make([]int64, len(rows))
	for i, r := range rows {
		marketIDs[i] = r.MarketID
		outcomeIDs[i] = r.OutcomeID
		names[i] = r.Name
		rawOdds[i] = r.RawOdds
		probs[i] = r.Probability
		actives[i] = r.Active
		lastTs[i] = r.LastOddinTs
	}
	const q = `
INSERT INTO market_outcomes
  (market_id, outcome_id, name, raw_odds, probability, active, last_oddin_ts, updated_at)
SELECT t.mid, t.oid, t.nm, t.odds::numeric, t.prob::numeric, t.act, t.lts, NOW()
  FROM UNNEST(
         $1::bigint[], $2::text[], $3::text[],
         $4::text[],   $5::text[], $6::bool[], $7::bigint[]
       ) AS t(mid, oid, nm, odds, prob, act, lts)
ON CONFLICT (market_id, outcome_id) DO UPDATE
   SET raw_odds      = COALESCE(EXCLUDED.raw_odds, market_outcomes.raw_odds),
       probability   = COALESCE(EXCLUDED.probability, market_outcomes.probability),
       active        = EXCLUDED.active,
       name          = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE market_outcomes.name END,
       last_oddin_ts = GREATEST(market_outcomes.last_oddin_ts, EXCLUDED.last_oddin_ts),
       updated_at    = NOW()`
	if _, err := db.Exec(ctx, q, marketIDs, outcomeIDs, names, rawOdds, probs, actives, lastTs); err != nil {
		return fmt.Errorf("upsert outcomes bulk: %w", err)
	}
	return nil
}

// AppendOddsHistoryBulk batch-inserts every odds_history row from one
// odds_change message in a single UNNEST INSERT. The semantics match
// AppendOddsHistory: append-only, no uniqueness constraint, duplicates
// (rare) are tolerated. We deliberately stay with INSERT-via-UNNEST
// over CopyFrom here so the call works against both *pgxpool.Pool and
// pgx.Tx — the latter has no CopyFrom of its own, and the handler is
// pool-scoped anyway.
func AppendOddsHistoryBulk(ctx context.Context, db pgxRunner, rows []OddsHistoryRow) error {
	if len(rows) == 0 {
		return nil
	}
	marketIDs := make([]int64, len(rows))
	outcomeIDs := make([]string, len(rows))
	rawOdds := make([]*string, len(rows))
	pubOdds := make([]*string, len(rows))
	probs := make([]*string, len(rows))
	ts := make([]time.Time, len(rows))
	for i, r := range rows {
		marketIDs[i] = r.MarketID
		outcomeIDs[i] = r.OutcomeID
		rawOdds[i] = r.RawOdds
		pubOdds[i] = r.PublishedOdds
		probs[i] = r.Probability
		ts[i] = r.Ts
	}
	const q = `
INSERT INTO odds_history (market_id, outcome_id, raw_odds, published_odds, probability, ts)
SELECT t.mid, t.oid, t.raw::numeric, t.pub::numeric, t.prob::numeric, t.ts
  FROM UNNEST(
         $1::bigint[], $2::text[],
         $3::text[],   $4::text[], $5::text[], $6::timestamptz[]
       ) AS t(mid, oid, raw, pub, prob, ts)`
	if _, err := db.Exec(ctx, q, marketIDs, outcomeIDs, rawOdds, pubOdds, probs, ts); err != nil {
		return fmt.Errorf("append odds_history bulk: %w", err)
	}
	return nil
}

// SweepHandoverTimeouts demotes any market that's been in pre-match → live
// "handed over" state (status=-2) for longer than `timeoutMs` to suspended
// (status=-1). Per Oddin docs §1.4: "if you do not receive live odds within
// a reasonable time after receiving the handed over state, consider this as
// an error and suspend all markets". 60s is the documented threshold.
//
// Returns the number of markets flipped.
func SweepHandoverTimeouts(ctx context.Context, db pgxRunner, timeoutMs int64) (int64, error) {
	tag, err := db.Exec(ctx, `
UPDATE markets
   SET status = -1,
       updated_at = NOW()
 WHERE status = -2
   AND last_oddin_ts < (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint - $1`, timeoutMs)
	if err != nil {
		return 0, fmt.Errorf("sweep handover timeouts: %w", err)
	}
	return tag.RowsAffected(), nil
}
