// Postgres store for the feed-ingester. Uses pgx directly rather than sqlc
// for MVP — the query surface is small and hand-written SQL is easier to
// reason about. Migrating to sqlc is an isolated change later.

package store

import (
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// Pool exposes the underlying pool for callers that need a transaction
// spanning multiple store methods.
func (s *Store) Pool() *pgxpool.Pool { return s.pool }

