// Batched write paths. The per-event UpdateOutcomePublishedOdds /
// AppendOddsHistoryPublished pair costs two round-trips per outcome tick,
// which capped the publisher at a few hundred ticks per second — fine for
// Oddin's esports volume, too slow once a second provider (Fonbet, ~200k
// priced outcomes) joins the stream. One UNNEST statement per batch keeps
// the exact same guards and lets the consumer drain thousands of ticks
// per second.

package store

import (
	"context"
	"fmt"
	"time"
)

// ResolveMarkets is the batch form of ResolveMarket: cache hits are served
// from the LRU, the misses are fetched with one `id = ANY($1)` query and
// cached. Markets that do not exist (race with the ingester) are simply
// absent from the result.
func (s *Store) ResolveMarkets(ctx context.Context, marketIDs []int64) (map[int64]MarketInfo, error) {
	out := make(map[int64]MarketInfo, len(marketIDs))
	var missing []int64
	for _, id := range marketIDs {
		if s.marketCache != nil {
			if info, ok := s.marketCache.Get(id); ok {
				out[id] = info
				continue
			}
		}
		missing = append(missing, id)
	}
	if len(missing) == 0 {
		return out, nil
	}
	const q = `
SELECT m.id, m.match_id, ma.tournament_id, c.sport_id, m.provider_market_id
  FROM markets m
  JOIN matches ma     ON ma.id = m.match_id
  JOIN tournaments t  ON t.id = ma.tournament_id
  JOIN categories c   ON c.id = t.category_id
 WHERE m.id = ANY($1::bigint[])`
	rows, err := s.pool.Query(ctx, q, missing)
	if err != nil {
		return nil, fmt.Errorf("resolve markets: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var info MarketInfo
		if err := rows.Scan(&info.MarketID, &info.MatchID, &info.TournamentID, &info.SportID, &info.ProviderMarketID); err != nil {
			return nil, fmt.Errorf("scan market info: %w", err)
		}
		out[info.MarketID] = info
		if s.marketCache != nil {
			s.marketCache.Add(info.MarketID, info)
		}
	}
	return out, rows.Err()
}

// PublishedRow is one outcome tick after margin has been applied.
type PublishedRow struct {
	MarketID      int64
	OutcomeID     string
	RawOdds       string
	PublishedOdds string
	Probability   string // "" when the feed omitted it
	SourceTs      int64  // ms
}

// UpdateOutcomesPublishedBulk mirrors UpdateOutcomePublishedOdds for many
// rows: published_odds is written, probability only when supplied, the
// timestamp moves forward only, and unchanged rows are a 0-row write.
//
// Callers must pass at most one row per (market_id, outcome_id): with
// duplicates `UPDATE ... FROM` applies an arbitrary one of them.
func (s *Store) UpdateOutcomesPublishedBulk(ctx context.Context, rows []PublishedRow) error {
	if len(rows) == 0 {
		return nil
	}
	marketIDs := make([]int64, len(rows))
	outcomeIDs := make([]string, len(rows))
	published := make([]string, len(rows))
	probs := make([]*string, len(rows))
	ts := make([]int64, len(rows))
	for i, r := range rows {
		marketIDs[i] = r.MarketID
		outcomeIDs[i] = r.OutcomeID
		published[i] = r.PublishedOdds
		if r.Probability != "" {
			p := r.Probability
			probs[i] = &p
		}
		ts[i] = r.SourceTs
	}
	const q = `
UPDATE market_outcomes mo
   SET published_odds = t.pub::numeric,
       probability    = COALESCE(t.prob::numeric, mo.probability),
       last_oddin_ts  = GREATEST(mo.last_oddin_ts, t.ts),
       updated_at     = NOW()
  FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::text[], $5::bigint[]) AS t(mid, oid, pub, prob, ts)
 WHERE mo.market_id = t.mid
   AND mo.outcome_id = t.oid
   AND (mo.published_odds IS DISTINCT FROM t.pub::numeric
        OR (t.prob IS NOT NULL AND mo.probability IS DISTINCT FROM t.prob::numeric))`
	if _, err := s.pool.Exec(ctx, q, marketIDs, outcomeIDs, published, probs, ts); err != nil {
		return fmt.Errorf("update published_odds bulk: %w", err)
	}
	return nil
}

// AppendOddsHistoryPublishedBulk inserts every tick of a batch in one
// statement (append-only, duplicates tolerated — same as the single-row
// path).
func (s *Store) AppendOddsHistoryPublishedBulk(ctx context.Context, rows []PublishedRow) error {
	if len(rows) == 0 {
		return nil
	}
	marketIDs := make([]int64, len(rows))
	outcomeIDs := make([]string, len(rows))
	raw := make([]string, len(rows))
	published := make([]string, len(rows))
	probs := make([]*string, len(rows))
	ts := make([]time.Time, len(rows))
	for i, r := range rows {
		marketIDs[i] = r.MarketID
		outcomeIDs[i] = r.OutcomeID
		raw[i] = r.RawOdds
		published[i] = r.PublishedOdds
		if r.Probability != "" {
			p := r.Probability
			probs[i] = &p
		}
		ts[i] = time.UnixMilli(r.SourceTs)
	}
	const q = `
INSERT INTO odds_history (market_id, outcome_id, raw_odds, published_odds, probability, ts)
SELECT t.mid, t.oid, t.raw::numeric, t.pub::numeric, t.prob::numeric, t.ts
  FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[]) AS t(mid, oid, raw, pub, prob, ts)`
	if _, err := s.pool.Exec(ctx, q, marketIDs, outcomeIDs, raw, published, probs, ts); err != nil {
		return fmt.Errorf("insert odds_history bulk: %w", err)
	}
	return nil
}
