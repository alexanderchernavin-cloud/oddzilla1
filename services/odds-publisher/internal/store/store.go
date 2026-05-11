// Postgres store for odds-publisher. Two read paths (market metadata +
// margin cascade) and two write paths (market_outcomes.published_odds and
// odds_history). All use pgxpool directly.

package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"

	lru "github.com/hashicorp/golang-lru/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// marketCacheSize bounds the in-process MarketInfo cache. 4096 fits the
// peak concurrent-market working set with comfortable headroom (hot
// matches × 30-150 markets each); each entry is ~40 bytes so the cache
// caps at well under 1 MiB. Sized large enough that recovery snapshots
// don't churn it.
const marketCacheSize = 4096

type Store struct {
	pool *pgxpool.Pool

	cacheMu     sync.RWMutex
	marginCache *marginCache

	// marketCache memoises the market→match→tournament→category lineage
	// resolved in ResolveMarket. The data is immutable for a market's
	// lifetime (IDs don't move), so no TTL is needed and stale reads are
	// impossible. Cache miss falls through to the 4-way JOIN; hit short-
	// circuits the round-trip. Mirrors the marginCache pattern above.
	marketCache *lru.Cache[int64, MarketInfo]
}

type marginCache struct {
	global          int
	sport           map[int]int    // sport_id → bp
	tournament      map[int]int    // tournament_id → bp
	marketType      map[int]int    // provider_market_id → bp
	fetchedAt       time.Time
}

func New(pool *pgxpool.Pool) *Store {
	// lru.New returns an error only when size <= 0; the constant above is
	// safe. We surface a panic anyway so a future copy-paste at size=0
	// fails loudly instead of silently disabling the cache.
	mc, err := lru.New[int64, MarketInfo](marketCacheSize)
	if err != nil {
		panic(fmt.Sprintf("odds-publisher: init market cache: %v", err))
	}
	return &Store{pool: pool, marketCache: mc}
}

// MarketInfo is everything the publisher needs for one outcome update:
// the raw + computed published odds, plus enough context to cascade-look-up
// the margin and address the right Redis channel.
type MarketInfo struct {
	MarketID         int64
	MatchID          int64
	TournamentID     int
	SportID          int
	ProviderMarketID int
}

// ResolveMarket returns the metadata for a market row. Called once per
// event processed; result is stable per market (IDs don't move). The
// 4-way JOIN to categories is hot — hundreds of QPS at peak Oddin
// throughput, all reading immutable IDs — so results are memoised in
// the per-process LRU. A market only gets evicted when 4095 fresher
// markets crowd it out, at which point re-resolving is cheap.
func (s *Store) ResolveMarket(ctx context.Context, marketID int64) (MarketInfo, error) {
	if s.marketCache != nil {
		if info, ok := s.marketCache.Get(marketID); ok {
			return info, nil
		}
	}
	const q = `
SELECT m.id, m.match_id, ma.tournament_id, c.sport_id, m.provider_market_id
  FROM markets m
  JOIN matches ma     ON ma.id = m.match_id
  JOIN tournaments t  ON t.id = ma.tournament_id
  JOIN categories c   ON c.id = t.category_id
 WHERE m.id = $1`
	var info MarketInfo
	err := s.pool.QueryRow(ctx, q, marketID).
		Scan(&info.MarketID, &info.MatchID, &info.TournamentID, &info.SportID, &info.ProviderMarketID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return info, fmt.Errorf("market %d not found (race with ingester?)", marketID)
		}
		return info, fmt.Errorf("resolve market: %w", err)
	}
	if s.marketCache != nil {
		s.marketCache.Add(marketID, info)
	}
	return info, nil
}

// LoadMarginCache reads every odds_config row into memory. Called on boot
// and whenever the cached snapshot is older than MarginCacheTTL. It's
// fine for this to be eventually consistent: admin writes take effect
// within one cache refresh.
func (s *Store) LoadMarginCache(ctx context.Context) (*marginCache, error) {
	const q = `
SELECT scope::text, scope_ref_id, payback_margin_bp
  FROM odds_config`
	rows, err := s.pool.Query(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("load margin cache: %w", err)
	}
	defer rows.Close()

	mc := &marginCache{
		global:     0,
		sport:      map[int]int{},
		tournament: map[int]int{},
		marketType: map[int]int{},
		fetchedAt:  time.Now(),
	}
	for rows.Next() {
		var scope string
		var refID sql.NullString
		var bp int
		if err := rows.Scan(&scope, &refID, &bp); err != nil {
			return nil, err
		}
		switch scope {
		case "global":
			mc.global = bp
		case "sport":
			if refID.Valid {
				var sid int
				if _, err := fmt.Sscanf(refID.String, "%d", &sid); err == nil {
					mc.sport[sid] = bp
				}
			}
		case "tournament":
			if refID.Valid {
				var tid int
				if _, err := fmt.Sscanf(refID.String, "%d", &tid); err == nil {
					mc.tournament[tid] = bp
				}
			}
		case "market_type":
			if refID.Valid {
				var mt int
				if _, err := fmt.Sscanf(refID.String, "%d", &mt); err == nil {
					mc.marketType[mt] = bp
				}
			}
		}
	}
	return mc, rows.Err()
}

// CurrentMargin returns the margin in basis points (0..5000) for a given
// market context, applying the cascade market_type → tournament → sport →
// global. Uses an in-memory cache refreshed every MarginCacheTTL.
func (s *Store) CurrentMargin(ctx context.Context, info MarketInfo, ttl time.Duration) (int, error) {
	s.cacheMu.RLock()
	cache := s.marginCache
	s.cacheMu.RUnlock()
	if cache == nil || time.Since(cache.fetchedAt) > ttl {
		fresh, err := s.LoadMarginCache(ctx)
		if err != nil {
			// If we can't refresh, fall back to the stale cache (if any).
			if cache == nil {
				return 0, err
			}
		} else {
			s.cacheMu.Lock()
			s.marginCache = fresh
			s.cacheMu.Unlock()
			cache = fresh
		}
	}

	if bp, ok := cache.marketType[info.ProviderMarketID]; ok {
		return bp, nil
	}
	if bp, ok := cache.tournament[info.TournamentID]; ok {
		return bp, nil
	}
	if bp, ok := cache.sport[info.SportID]; ok {
		return bp, nil
	}
	return cache.global, nil
}

// UpdateOutcomePublishedOdds writes the computed published_odds back to
// the market_outcomes row. Bumps last_oddin_ts monotonically. The
// probability arg may be "" — in that case we leave the existing
// probability column alone (the ingester already wrote it on its pass).
func (s *Store) UpdateOutcomePublishedOdds(ctx context.Context, marketID int64, outcomeID, publishedOdds, probability string, oddinTs int64) error {
	const q = `
UPDATE market_outcomes
   SET published_odds = $3::numeric,
       probability    = COALESCE($4::numeric, probability),
       last_oddin_ts  = GREATEST(last_oddin_ts, $5),
       updated_at     = NOW()
 WHERE market_id = $1 AND outcome_id = $2`
	var prob any
	if probability != "" {
		prob = probability
	}
	if _, err := s.pool.Exec(ctx, q, marketID, outcomeID, publishedOdds, prob, oddinTs); err != nil {
		return fmt.Errorf("update published_odds: %w", err)
	}
	return nil
}

// AppendOddsHistoryPublished inserts one row with both raw + published
// odds. The ingester already wrote a row with raw only; this one carries
// the published snapshot. Readers filtering by ts DESC always see the
// latest publication.
func (s *Store) AppendOddsHistoryPublished(ctx context.Context, marketID int64, outcomeID, rawOdds, publishedOdds, probability string, ts time.Time) error {
	const q = `
INSERT INTO odds_history (market_id, outcome_id, raw_odds, published_odds, probability, ts)
VALUES ($1, $2, $3::numeric, $4::numeric, $5::numeric, $6)`
	var prob any
	if probability != "" {
		prob = probability
	}
	if _, err := s.pool.Exec(ctx, q, marketID, outcomeID, rawOdds, publishedOdds, prob, ts); err != nil {
		return fmt.Errorf("insert odds_history: %w", err)
	}
	return nil
}

// Pool exposes the underlying pool for future callers.
func (s *Store) Pool() *pgxpool.Pool { return s.pool }
