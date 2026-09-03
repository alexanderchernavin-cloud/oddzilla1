// Postgres store for odds-publisher. Two read paths (batched market
// lineage + margin cascade) and two batched write paths
// (market_outcomes.published_odds and odds_history, see bulk.go). All use
// pgxpool directly.

package store

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"time"

	lru "github.com/hashicorp/golang-lru/v2"
	"github.com/jackc/pgx/v5/pgxpool"
)

// marketCacheSize bounds the in-process MarketInfo cache. Each entry is
// ~40 bytes, so 131072 entries cap at a few MiB. Sized for the combined
// working set of Oddin (a few thousand hot markets) and the Fonbet line
// (~90k markets across ~3.5k matches) so ResolveMarkets rarely misses
// once warm; 4096 thrashed constantly with the second provider on.
const marketCacheSize = 131072

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
	global     int
	sport      map[int]int // sport_id → bp
	tournament map[int]int // tournament_id → bp
	marketType map[int]int // provider_market_id → bp
	fetchedAt  time.Time
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
	// Resolve each per-scope row into the matching map. The scope_ref_id
	// column is stored as text but always holds a serialised int for
	// these three scopes.
	scopeMap := map[string]map[int]int{
		"sport":       mc.sport,
		"tournament":  mc.tournament,
		"market_type": mc.marketType,
	}
	for rows.Next() {
		var scope string
		var refID sql.NullString
		var bp int
		if err := rows.Scan(&scope, &refID, &bp); err != nil {
			return nil, err
		}
		if scope == "global" {
			mc.global = bp
			continue
		}
		dest, ok := scopeMap[scope]
		if !ok || !refID.Valid {
			continue
		}
		var id int
		if _, err := fmt.Sscanf(refID.String, "%d", &id); err == nil {
			dest[id] = bp
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
