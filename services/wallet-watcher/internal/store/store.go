// Postgres operations for wallet-watcher.
//
// Post-0032 the surface is intent-driven:
//   • ListPendingIntents — rows the watcher hasn't finished processing.
//   • MarkConfirming — first time we see a tx receipt, capture the
//     parsed Transfer (block, hash, log_index, from, amount).
//   • UpdateIntentConfirmations — bump confirmations counter.
//   • CreditIntent — atomic credit (UPDATE intent + UPDATE wallet +
//     INSERT wallet_ledger). The ledger's unique partial index on
//     (type, ref_type, ref_id) makes the whole thing replay-safe.
//   • RejectIntent — terminal "the watcher couldn't validate this".
//   • ManualCreditIntent — admin override; same atomicity as Credit.

package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// PendingIntent is a deposit_intents row in pending or confirming
// state. The watcher polls these every tick.
type PendingIntent struct {
	ID            string
	UserID        string
	Network       string
	TxHash        string
	BlockNumber   int64
	BlockHash     string
	LogIndex      int
	FromAddress   string
	ToAddress     string
	AmountMicro   int64
	Confirmations int
	Status        string // 'pending' | 'confirming'
}

// ListPendingIntents returns intents the watcher needs to evaluate
// this tick.
func (s *Store) ListPendingIntents(ctx context.Context, limit int) ([]PendingIntent, error) {
	const q = `
SELECT id, user_id, network::text, tx_hash,
       COALESCE(block_number, 0), COALESCE(block_hash, ''),
       COALESCE(log_index, 0), COALESCE(from_address, ''),
       COALESCE(to_address, ''), COALESCE(amount_micro, 0),
       confirmations, status::text
  FROM deposit_intents
 WHERE status IN ('pending', 'confirming')
 ORDER BY submitted_at
 LIMIT $1`
	rows, err := s.pool.Query(ctx, q, limit)
	if err != nil {
		return nil, fmt.Errorf("list pending intents: %w", err)
	}
	defer rows.Close()

	out := make([]PendingIntent, 0, limit)
	for rows.Next() {
		var p PendingIntent
		if err := rows.Scan(
			&p.ID, &p.UserID, &p.Network, &p.TxHash,
			&p.BlockNumber, &p.BlockHash, &p.LogIndex,
			&p.FromAddress, &p.ToAddress, &p.AmountMicro,
			&p.Confirmations, &p.Status,
		); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// IntentReceipt holds the parsed on-chain data captured the first
// time the watcher resolves an intent's tx receipt.
type IntentReceipt struct {
	BlockNumber int64
	BlockHash   string
	LogIndex    int
	FromAddress string
	ToAddress   string
	AmountMicro int64
}

// MarkConfirming flips a pending intent to 'confirming' and persists
// the parsed Transfer. Idempotent — a re-call with a different log
// index is treated as authoritative (the latest tick wins, since the
// receipt is canonical once the tx is mined).
func (s *Store) MarkConfirming(ctx context.Context, id string, r IntentReceipt, confirmations int) error {
	const q = `
UPDATE deposit_intents
   SET status        = 'confirming',
       block_number  = $2,
       block_hash    = NULLIF($3, ''),
       log_index     = $4,
       from_address  = NULLIF($5, ''),
       to_address    = NULLIF($6, ''),
       amount_micro  = $7,
       confirmations = GREATEST(confirmations, $8)
 WHERE id = $1
   AND status IN ('pending', 'confirming')`
	_, err := s.pool.Exec(ctx, q,
		id, r.BlockNumber, r.BlockHash, r.LogIndex,
		r.FromAddress, r.ToAddress, r.AmountMicro,
		confirmations,
	)
	if err != nil {
		return fmt.Errorf("mark confirming: %w", err)
	}
	return nil
}

// UpdateIntentConfirmations bumps the confirmations counter on an
// intent that's already in 'confirming' state. Never regresses.
func (s *Store) UpdateIntentConfirmations(ctx context.Context, id string, confirmations int) error {
	_, err := s.pool.Exec(ctx, `
UPDATE deposit_intents
   SET confirmations = GREATEST(confirmations, $2)
 WHERE id = $1
   AND status IN ('pending', 'confirming')`, id, confirmations)
	if err != nil {
		return fmt.Errorf("update intent confirmations: %w", err)
	}
	return nil
}

// RejectIntent marks an intent terminal-rejected with a reason.
// Idempotent — re-rejecting a row already at 'rejected' / 'credited'
// is a no-op.
func (s *Store) RejectIntent(ctx context.Context, id, reason string) error {
	_, err := s.pool.Exec(ctx, `
UPDATE deposit_intents
   SET status         = 'rejected',
       failure_reason = $2,
       rejected_at    = NOW()
 WHERE id = $1
   AND status IN ('pending', 'confirming')`, id, reason)
	if err != nil {
		return fmt.Errorf("reject intent: %w", err)
	}
	return nil
}

// CreditIntent runs the atomic transition:
//
//	UPDATE deposit_intents SET status='credited', credited_at=NOW()
//	UPDATE wallets         SET balance_micro += amount        (USDC, currency-scoped)
//	INSERT wallet_ledger   (deposit, ref_id=intent.id)        (apply-once)
//
// The wallet_ledger's unique partial index on (type, ref_type, ref_id)
// is the ultimate double-credit guard.
//
// pre-conditions:
//   - intent.AmountMicro > 0
//   - intent.UserID exists with a USDC wallet row (created at signup)
func (s *Store) CreditIntent(ctx context.Context, intent PendingIntent) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `
UPDATE deposit_intents
   SET status      = 'credited',
       credited_at = NOW()
 WHERE id = $1
   AND status IN ('pending', 'confirming')`, intent.ID)
	if err != nil {
		return fmt.Errorf("mark credited: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// Already credited (or rejected) — replay no-op.
		return tx.Commit(ctx)
	}

	if _, err := tx.Exec(ctx, `
UPDATE wallets
   SET balance_micro = balance_micro + $2,
       updated_at    = NOW()
 WHERE user_id = $1 AND currency = 'USDC'`, intent.UserID, intent.AmountMicro); err != nil {
		return fmt.Errorf("credit wallet: %w", err)
	}

	if _, err := tx.Exec(ctx, `
INSERT INTO wallet_ledger (user_id, currency, delta_micro, type, ref_type, ref_id, tx_hash, memo)
VALUES ($1, 'USDC', $2, 'deposit', 'deposit_intent', $3, $4, NULL)
ON CONFLICT (type, ref_type, ref_id) WHERE ref_id IS NOT NULL DO NOTHING`,
		intent.UserID, intent.AmountMicro, intent.ID, intent.TxHash); err != nil {
		return fmt.Errorf("ledger deposit: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit credit: %w", err)
	}
	return nil
}

// IntentByID returns the PendingIntent shape regardless of current
// status. Used by the API admin override path.
func (s *Store) IntentByID(ctx context.Context, id string) (PendingIntent, error) {
	const q = `
SELECT id, user_id, network::text, tx_hash,
       COALESCE(block_number, 0), COALESCE(block_hash, ''),
       COALESCE(log_index, 0), COALESCE(from_address, ''),
       COALESCE(to_address, ''), COALESCE(amount_micro, 0),
       confirmations, status::text
  FROM deposit_intents
 WHERE id = $1`
	var p PendingIntent
	err := s.pool.QueryRow(ctx, q, id).Scan(
		&p.ID, &p.UserID, &p.Network, &p.TxHash,
		&p.BlockNumber, &p.BlockHash, &p.LogIndex,
		&p.FromAddress, &p.ToAddress, &p.AmountMicro,
		&p.Confirmations, &p.Status,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return p, fmt.Errorf("intent_not_found")
		}
		return p, fmt.Errorf("intent by id: %w", err)
	}
	return p, nil
}

