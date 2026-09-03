// Postgres store for fonbet-ingester. Hand-written pgx SQL against the
// same tables feed-ingester writes (CLAUDE.md invariant 5: Go services
// read the Drizzle-owned schema directly). Copied rather than shared per
// the one-module-per-service rule; provider-specific bits use 'fonbet'.

package store

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Provider is the value written to sports.provider / competitors.provider.
const Provider = "fonbet"

// URN prefixes. tournaments.provider_urn and matches.provider_urn are
// globally unique with no provider column, so every Fonbet URN carries the
// `fb:` namespace to stay clear of Oddin's `od:` ids.
const (
	URNSport      = "fb:sport:"
	URNTournament = "fb:tournament:"
	URNMatch      = "fb:match:"
	URNCompetitor = "fb:competitor:"
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// pgxRunner is the subset of pgx APIs both pgxpool.Pool and pgx.Tx satisfy.
type pgxRunner interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	SendBatch(ctx context.Context, b *pgx.Batch) pgx.BatchResults
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}
