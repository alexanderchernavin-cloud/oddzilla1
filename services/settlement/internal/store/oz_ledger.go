// Go-side Oz ledger writer. Mirrors the TS primitive in
// services/api/src/modules/community/oz-ledger.ts — the two MUST stay
// SQL-compatible because both can write the same table (TS via the
// admin credit endpoint and future engagement-floor hook; Go via the
// settler tx). The shared idempotency_key UNIQUE constraint makes the
// two-writer arrangement safe: same key = exactly one row, regardless
// of which writer got there first.
//
// V1 mode is earn-only — the DB CHECK constraint enforces delta > 0
// (migration 0076). This file does not need to handle spend; when the
// redemption flow lands it will likely live entirely on the TS side
// (admin redemption / user-initiated spend), and this Go writer stays
// credit-only.
//
// Why a Go-side writer (instead of emitting a settlement event for a
// TS subscriber to consume): keeps the credit atomic with the
// settlement transaction. A settle that succeeds but whose post-hoc
// Oz credit fails would either lose the credit or require a second
// reconciliation worker. Writing inline removes that class of
// failure.

package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// CreditOzInput mirrors the TS CreditOzInput type. Note `Delta` is an
// int64 (not bigint) because realistic per-credit values are far below
// 2^63 — the Reward formula V1 cap is 250 Oz per credit. The column
// is BIGINT for header-room only.
type CreditOzInput struct {
	UserID          string
	Delta           int64
	Reason          string
	SourceKind      string // "analysis" | "admin" | "" if absent
	SourceID        string // empty if absent
	IdempotencyKey  string
	CreatedBy       string // empty if absent (system credits)
}

// CreditOzResult mirrors the TS shape. Credited=false on idempotency-
// key collision; never an error.
type CreditOzResult struct {
	Credited     bool
	BalanceAfter int64
}

// CreditOz inserts a ledger row and upserts oz_balance_user atomically.
// Same CTE shape as the TS primitive — the SQL is intentionally copy-
// paste-compatible so future audit tools can diff the two writers.
//
// Caller MUST construct a deterministic idempotency key from the
// (reason, source) pair. A second call with the same key returns
// `{Credited: false, BalanceAfter: <current balance>}` rather than an
// error.
func CreditOz(ctx context.Context, tx pgx.Tx, input CreditOzInput) (CreditOzResult, error) {
	if input.Delta <= 0 {
		return CreditOzResult{}, fmt.Errorf("oz_credit_invalid_delta: %d", input.Delta)
	}

	// nilIfEmpty bridges Go's "" semantics to SQL NULL — we want
	// source_kind / source_id / created_by NULL when not set rather
	// than empty strings.
	var sourceKind, sourceID, createdBy any
	if input.SourceKind != "" {
		sourceKind = input.SourceKind
	}
	if input.SourceID != "" {
		sourceID = input.SourceID
	}
	if input.CreatedBy != "" {
		createdBy = input.CreatedBy
	}

	const q = `
WITH ins AS (
  INSERT INTO oz_ledger
    (user_id, delta, reason, source_kind, source_id, idempotency_key, created_by)
  VALUES
    ($1::uuid, $2::bigint, $3::text, $4::text, $5::text, $6::text, $7::uuid)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING delta
),
bump AS (
  INSERT INTO oz_balance_user (user_id, balance, updated_at)
  SELECT $1::uuid, ins.delta, NOW()
    FROM ins
  ON CONFLICT (user_id) DO UPDATE
    SET balance    = oz_balance_user.balance + EXCLUDED.balance,
        updated_at = NOW()
  RETURNING balance
)
SELECT
  EXISTS (SELECT 1 FROM ins)                                AS credited,
  COALESCE(
    (SELECT balance FROM bump),
    (SELECT balance FROM oz_balance_user WHERE user_id = $1::uuid),
    0
  )::bigint                                                 AS balance_after
`
	var res CreditOzResult
	if err := tx.QueryRow(
		ctx, q,
		input.UserID,
		input.Delta,
		input.Reason,
		sourceKind,
		sourceID,
		input.IdempotencyKey,
		createdBy,
	).Scan(&res.Credited, &res.BalanceAfter); err != nil {
		return CreditOzResult{}, fmt.Errorf("oz credit: %w", err)
	}
	return res, nil
}

// OzFromStakeMicros mirrors the TS helper in analyses-rewards.ts.
// Stake-scaled Oz reward: 25% of stake in stake units (micros / 1M),
// floored at 1 Oz, capped at 250. Currency-agnostic by construction.
//
// Used by both the engagement-floor credit (TS) and the win-bonus
// credit (Go). Two callers, one formula — kept in sync by code
// review across the language boundary.
func OzFromStakeMicros(stakeMicro int64) int64 {
	stakeUnits := stakeMicro / 1_000_000
	raw := stakeUnits / 4 // * 0.25
	if raw < 1 {
		return 1
	}
	if raw > 250 {
		return 250
	}
	return raw
}
