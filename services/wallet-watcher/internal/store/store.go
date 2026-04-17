// Postgres operations for wallet-watcher. Two broad concerns:
//   • Deposit ingestion — insert on first sight, progress confirmations,
//     credit on threshold reached. All wallet changes go through a
//     transaction with a wallet_ledger INSERT keyed on (type, ref_type,
//     ref_id) so replay is a no-op at the row level.
//   • Scanner cursor — per-chain last-scanned block number lives in
//     `chain_scanner_state` (added in migration 0002).

package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// ─── Cursor ────────────────────────────────────────────────────────────────

// Chain is the chain_network enum value: "TRC20" or "ERC20".
type Chain string

const (
	ChainTRC20 Chain = "TRC20"
	ChainERC20 Chain = "ERC20"
)

func (c Chain) String() string { return string(c) }

// LastBlock returns the last-scanned block for a chain, or 0 on first run.
func (s *Store) LastBlock(ctx context.Context, chain Chain) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx, `
SELECT last_block_number
  FROM chain_scanner_state
 WHERE chain = $1::chain_network`, string(chain)).Scan(&n)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, fmt.Errorf("read cursor %s: %w", chain, err)
	}
	return n, nil
}

// BumpCursor sets the scanner cursor forward. Never regresses.
func (s *Store) BumpCursor(ctx context.Context, chain Chain, block int64) error {
	_, err := s.pool.Exec(ctx, `
INSERT INTO chain_scanner_state (chain, last_block_number, updated_at)
VALUES ($1::chain_network, $2, NOW())
ON CONFLICT (chain) DO UPDATE
   SET last_block_number = GREATEST(chain_scanner_state.last_block_number, EXCLUDED.last_block_number),
       updated_at = NOW()`, string(chain), block)
	if err != nil {
		return fmt.Errorf("bump cursor %s: %w", chain, err)
	}
	return nil
}

// ─── Address lookup ────────────────────────────────────────────────────────

// AddressOwner returns (userId, true) if `toAddress` maps to a known
// deposit_addresses row for the given chain, else (_, false).
//
// Address comparison is case-insensitive for ERC20 (EIP-55 mixed-case
// checksums often differ from what chain events emit) and exact for TRC20
// (Base58 is case-sensitive). Ethereum addresses are stored in their
// checksummed form by the API; we normalize to lower here.
func (s *Store) AddressOwner(ctx context.Context, chain Chain, toAddress string) (string, bool, error) {
	var q string
	var arg string
	if chain == ChainERC20 {
		q = `SELECT user_id FROM deposit_addresses WHERE network = 'ERC20' AND LOWER(address) = $1`
		arg = strings.ToLower(toAddress)
	} else {
		q = `SELECT user_id FROM deposit_addresses WHERE network = 'TRC20' AND address = $1`
		arg = toAddress
	}
	var userID string
	err := s.pool.QueryRow(ctx, q, arg).Scan(&userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("address owner lookup: %w", err)
	}
	return userID, true, nil
}

// ─── Deposit insert ────────────────────────────────────────────────────────

// DepositInsert represents a newly-observed on-chain Transfer event.
type DepositInsert struct {
	UserID      string
	Chain       Chain
	TxHash      string
	LogIndex    int
	ToAddress   string
	AmountMicro int64
	BlockNumber int64
	SeenAt      time.Time
}

// InsertSeen upserts a deposit row on first sight. Returns (id, true) for
// a fresh insert, (id, false) if the row already existed (replay).
func (s *Store) InsertSeen(ctx context.Context, d DepositInsert) (string, bool, error) {
	const q = `
INSERT INTO deposits
  (user_id, network, tx_hash, log_index, to_address, amount_micro, block_number, status, seen_at)
VALUES ($1, $2::chain_network, $3, $4, $5, $6, $7, 'seen', $8)
ON CONFLICT (network, tx_hash, log_index) DO NOTHING
RETURNING id`
	var id string
	err := s.pool.QueryRow(ctx, q,
		d.UserID, string(d.Chain), d.TxHash, d.LogIndex, d.ToAddress,
		d.AmountMicro, d.BlockNumber, d.SeenAt,
	).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Already exists; fetch the id so the caller can re-use it.
			existingID, err := s.findExistingDeposit(ctx, d.Chain, d.TxHash, d.LogIndex)
			if err != nil {
				return "", false, err
			}
			return existingID, false, nil
		}
		return "", false, fmt.Errorf("insert deposit: %w", err)
	}
	return id, true, nil
}

func (s *Store) findExistingDeposit(ctx context.Context, chain Chain, txHash string, logIndex int) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `
SELECT id FROM deposits
 WHERE network = $1::chain_network AND tx_hash = $2 AND log_index = $3`,
		string(chain), txHash, logIndex).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("find existing deposit: %w", err)
	}
	return id, nil
}

// PendingDeposit is a deposit that hasn't yet been credited. The caller
// polls these each tick and advances confirmations / credits.
type PendingDeposit struct {
	ID            string
	UserID        string
	Chain         Chain
	TxHash        string
	LogIndex      int
	AmountMicro   int64
	BlockNumber   int64
	Confirmations int
	Status        string
}

// ListPending returns uncredited deposits for a chain, ordered by block.
func (s *Store) ListPending(ctx context.Context, chain Chain, limit int) ([]PendingDeposit, error) {
	const q = `
SELECT id, user_id, network::text, tx_hash, log_index, amount_micro,
       COALESCE(block_number, 0), confirmations, status::text
  FROM deposits
 WHERE network = $1::chain_network
   AND status IN ('seen', 'confirming')
 ORDER BY COALESCE(block_number, 0)
 LIMIT $2`
	rows, err := s.pool.Query(ctx, q, string(chain), limit)
	if err != nil {
		return nil, fmt.Errorf("list pending: %w", err)
	}
	defer rows.Close()

	out := make([]PendingDeposit, 0, limit)
	for rows.Next() {
		var p PendingDeposit
		var chainStr string
		if err := rows.Scan(&p.ID, &p.UserID, &chainStr, &p.TxHash, &p.LogIndex,
			&p.AmountMicro, &p.BlockNumber, &p.Confirmations, &p.Status); err != nil {
			return nil, err
		}
		p.Chain = Chain(chainStr)
		out = append(out, p)
	}
	return out, rows.Err()
}

// UpdateConfirmations bumps the confirmation count on a not-yet-credited
// deposit. Idempotent: advancing it backwards is disallowed by the check.
func (s *Store) UpdateConfirmations(ctx context.Context, id string, confirmations int) error {
	_, err := s.pool.Exec(ctx, `
UPDATE deposits
   SET confirmations = GREATEST(confirmations, $2),
       status = CASE
                  WHEN status = 'seen' AND $2 > 0 THEN 'confirming'::deposit_status
                  ELSE status
                END
 WHERE id = $1`, id, confirmations)
	if err != nil {
		return fmt.Errorf("update confirmations: %w", err)
	}
	return nil
}

// Credit runs the atomic: deposit→credited + wallet.balance += amount +
// wallet_ledger(type=deposit, ref_id=deposit.id). The ledger's unique
// partial index makes this replay-safe.
func (s *Store) Credit(ctx context.Context, p PendingDeposit) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `
UPDATE deposits
   SET status = 'credited',
       credited_at = NOW()
 WHERE id = $1 AND status IN ('seen', 'confirming')`, p.ID)
	if err != nil {
		return fmt.Errorf("mark credited: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// Already credited — nothing to do.
		return tx.Commit(ctx)
	}

	if _, err := tx.Exec(ctx, `
UPDATE wallets
   SET balance_micro = balance_micro + $2,
       updated_at = NOW()
 WHERE user_id = $1`, p.UserID, p.AmountMicro); err != nil {
		return fmt.Errorf("credit wallet: %w", err)
	}

	if _, err := tx.Exec(ctx, `
INSERT INTO wallet_ledger (user_id, delta_micro, type, ref_type, ref_id, tx_hash, memo)
VALUES ($1, $2, 'deposit', 'deposit', $3, $4, NULL)
ON CONFLICT (type, ref_type, ref_id) WHERE ref_id IS NOT NULL DO NOTHING`,
		p.UserID, p.AmountMicro, p.ID, p.TxHash); err != nil {
		return fmt.Errorf("ledger deposit: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit credit: %w", err)
	}
	return nil
}
