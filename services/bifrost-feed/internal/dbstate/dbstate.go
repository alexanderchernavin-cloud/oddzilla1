// Read-only view of our own catalogue, used to make settlement emission
// stateless and idempotent: a bet_settlement is synthesised only for
// markets that exist in Postgres and are not already terminal there.
// Because the decision reads DB truth on every pass rather than an
// in-memory "already emitted" set, a restart, a missed frame, or a
// primary-feed recovery that settled the market first all converge on the
// same answer without any coordination.

package dbstate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/oddzilla/bifrost-feed/internal/bifrost"
	"github.com/oddzilla/bifrost-feed/internal/gate"
)

// Filter answers "may I settle this market" for one match.
type Filter struct {
	// Known is false when the match is absent from our catalogue: nothing
	// to settle, no tickets can exist.
	Known bool
	// AllOpen short-circuits the lookup (dry-run mode).
	AllOpen bool
	// Open holds the non-terminal markets we currently have for the match.
	Open map[bifrost.MarketKey]struct{}
}

// Settleable reports whether a settlement for key should be emitted.
func (f Filter) Settleable(key bifrost.MarketKey) bool {
	if !f.Known {
		return false
	}
	if f.AllOpen {
		return true
	}
	_, ok := f.Open[key]
	return ok
}

// Source is what the runner depends on; the dry-run mode substitutes an
// implementation that treats every market as open and known.
type Source interface {
	OpenMarkets(ctx context.Context, matchURN string) (Filter, error)
}

type DB struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *DB { return &DB{pool: pool} }

// OpenMarkets lists the markets on the match whose status is not -3
// (settled) or -4 (cancelled), keyed the way Bifrost ids decode.
func (d *DB) OpenMarkets(ctx context.Context, matchURN string) (Filter, error) {
	rows, err := d.pool.Query(ctx, `
SELECT mk.provider_market_id, mk.specifiers_json
  FROM matches m
  LEFT JOIN markets mk
    ON mk.match_id = m.id
   AND mk.status NOT IN (-3, -4)
 WHERE m.provider_urn = $1`, matchURN)
	if err != nil {
		return Filter{}, fmt.Errorf("open markets %s: %w", matchURN, err)
	}
	defer rows.Close()
	f := Filter{Open: make(map[bifrost.MarketKey]struct{})}
	for rows.Next() {
		f.Known = true
		var pmid *int
		var specs []byte
		if err := rows.Scan(&pmid, &specs); err != nil {
			return Filter{}, err
		}
		if pmid == nil {
			continue // match exists, this LEFT JOIN row carries no open market
		}
		f.Open[bifrost.MarketKey{ProviderMarketID: *pmid, Specifiers: canonicalFromJSON(specs)}] = struct{}{}
	}
	return f, rows.Err()
}

// canonicalFromJSON rebuilds the sorted `k=v|k=v` string from the
// specifiers_json map feed-ingester persisted. Same algorithm as
// oddinxml.Canonical, so the key matches what ParseMarketID produces.
func canonicalFromJSON(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var m map[string]string
	if err := json.Unmarshal(raw, &m); err != nil || len(m) == 0 {
		return ""
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+m[k])
	}
	return strings.Join(parts, "|")
}

// ReadControl returns the operator's feed source switch (migration 0095,
// singleton feed_control row). A missing row reads as an unset switch so
// the env default applies.
func (d *DB) ReadControl(ctx context.Context) (gate.Control, error) {
	var (
		source   string
		switched time.Time
		flushed  *time.Time
	)
	err := d.pool.QueryRow(ctx, `SELECT source, switched_at, flushed_at FROM feed_control WHERE id = 1`).
		Scan(&source, &switched, &flushed)
	if errors.Is(err, pgx.ErrNoRows) {
		return gate.Control{}, nil
	}
	if err != nil {
		return gate.Control{}, fmt.Errorf("read feed_control: %w", err)
	}
	c := gate.Control{Source: source, SwitchedAt: switched}
	if flushed != nil {
		c.FlushedAt = *flushed
	}
	return c, nil
}

// Permissive treats every market as known and open and reports no
// operator switch. Dry-run only: it makes the translator emit a settlement
// for every fully settled market it sees, which is what an operator wants
// to eyeball.
type Permissive struct{}

func (Permissive) OpenMarkets(_ context.Context, _ string) (Filter, error) {
	return Filter{Known: true, AllOpen: true}, nil
}

func (Permissive) ReadControl(_ context.Context) (gate.Control, error) {
	return gate.Control{}, nil
}
