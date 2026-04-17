// Postgres store for the feed-ingester. Uses pgx directly rather than sqlc
// for MVP — the query surface is small and hand-written SQL is easier to
// reason about. Migrating to sqlc is an isolated change later.

package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
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

// WithTx runs fn inside a transaction. Rolls back on error.
func (s *Store) WithTx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() {
		_ = tx.Rollback(ctx) // no-op if committed
	}()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
