// Postgres store for slotzilla. Hand-written pgx SQL against the
// Drizzle-owned schema (CLAUDE.md invariant 5); every statement is a
// package constant and every function runs exactly one of them, except
// the two money transactions in spins.go, which compose those functions
// under one tx. The wallet + ledger idioms are copied from
// services/settlement/internal/store (per the one-module-per-service
// rule): every wallet write is scoped by (user_id, currency), every
// credit carries a stable ref_id and rides the wallet_ledger unique
// partial index (invariant 4), and RiskZilla's open liability moves for
// USDC only, in both directions.

package store

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// runner is the subset of pgx APIs both pgxpool.Pool and pgx.Tx satisfy.
type runner interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// Ping is the health probe.
func (s *Store) Ping(ctx context.Context) error {
	return s.pool.Ping(ctx)
}
