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
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/oddzilla/wallet-watcher/internal/currency"
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// ─── Discovery cursor (chain_scanner_state) ────────────────────────────────

// Chain mirrors the chain_network enum value. Only ERC20 in active use
// post-0032; legacy TRC20 row is dropped by the migration.
type Chain string

const (
	ChainERC20 Chain = "ERC20"
)

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

// BumpCursor advances the discovery cursor. Never regresses.
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

// LookupUserByWalletAddress returns (userId, true) if the address
// belongs to a registered linked wallet, else (_, false).
func (s *Store) LookupUserByWalletAddress(ctx context.Context, chain Chain, address string) (string, bool, error) {
	var userID string
	err := s.pool.QueryRow(ctx, `
SELECT user_id
  FROM user_wallet_addresses
 WHERE network = $1::chain_network AND address = $2`,
		string(chain), strings.ToLower(address)).Scan(&userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("lookup wallet address: %w", err)
	}
	return userID, true, nil
}

// DiscoveredIntent is a Transfer event observed by the discovery loop
// whose `from` is registered to a user.
type DiscoveredIntent struct {
	UserID      string
	Network     string // 'ERC20'
	TxHash      string
	From        string
	To          string
	AmountMicro int64
	BlockNumber int64
	BlockHash   string
	LogIndex    int
}

// InsertDiscoveredIntent records a Transfer the discoverer attributed to
// a linked wallet. Idempotent on (network, tx_hash) — if the user
// already pasted this tx hash, we leave their pending row alone and
// the processor's Inspect call will resolve it.
func (s *Store) InsertDiscoveredIntent(ctx context.Context, d DiscoveredIntent) error {
	_, err := s.pool.Exec(ctx, `
INSERT INTO deposit_intents
  (user_id, network, tx_hash, from_address, to_address, amount_micro,
   block_number, block_hash, log_index, confirmations, status)
VALUES ($1, $2::chain_network, $3, $4, $5, $6, $7, $8, $9, 0, 'confirming')
ON CONFLICT (network, tx_hash) DO NOTHING`,
		d.UserID, d.Network, d.TxHash, d.From, d.To, d.AmountMicro,
		d.BlockNumber, d.BlockHash, d.LogIndex)
	if err != nil {
		return fmt.Errorf("insert discovered intent: %w", err)
	}
	return nil
}

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

// intentColumns and scanIntent are shared by ListPendingIntents and
// IntentByID — both surface the same `deposit_intents` projection
// with the same COALESCE shape, just different WHERE clauses.
const intentColumns = `id, user_id, network::text, tx_hash,
       COALESCE(block_number, 0), COALESCE(block_hash, ''),
       COALESCE(log_index, 0), COALESCE(from_address, ''),
       COALESCE(to_address, ''), COALESCE(amount_micro, 0),
       confirmations, status::text`

func scanIntent(row pgx.Row, p *PendingIntent) error {
	return row.Scan(
		&p.ID, &p.UserID, &p.Network, &p.TxHash,
		&p.BlockNumber, &p.BlockHash, &p.LogIndex,
		&p.FromAddress, &p.ToAddress, &p.AmountMicro,
		&p.Confirmations, &p.Status,
	)
}

// ListPendingIntents returns intents the watcher needs to evaluate
// this tick.
func (s *Store) ListPendingIntents(ctx context.Context, limit int) ([]PendingIntent, error) {
	q := `SELECT ` + intentColumns + `
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
		if err := scanIntent(rows, &p); err != nil {
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

// RejectIntentWrongToken rejects with failure_reason='wrong_token' and
// stamps the diagnostic columns so the admin Wrong-Token tab can show
// "100 USDT @ 0xdAC1..." rather than a generic "no_usdc_transfer".
// `amountRaw` is the uint256 amount as a decimal string — the unknown
// token's decimals aren't known at this layer; UI applies them on render.
// Idempotent across the same row state guard as RejectIntent.
//
// Also opportunistically acks any unattributed_deposits row that matches
// the same (network, tx_hash): if the wider unattributed scan beat the
// intent-rejection path to inserting the row, this dedups the alert so
// admin sees one incident, not two.
func (s *Store) RejectIntentWrongToken(ctx context.Context, id, tokenContract, amountRaw, fromAddr string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin reject wrong_token: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `
UPDATE deposit_intents
   SET status                    = 'rejected',
       failure_reason            = 'wrong_token',
       detected_token_contract   = $2,
       detected_token_amount_raw = $3::NUMERIC,
       from_address              = COALESCE(NULLIF($4, ''), from_address),
       rejected_at               = NOW()
 WHERE id = $1
   AND status IN ('pending', 'confirming')`,
		id, strings.ToLower(tokenContract), amountRaw, strings.ToLower(fromAddr),
	)
	if err != nil {
		return fmt.Errorf("reject wrong_token: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return tx.Commit(ctx)
	}

	// Best-effort dedup against unattributed_deposits. We don't have
	// log_index on the intent row, so match on (network, tx_hash). The
	// note is appended so an existing manual note (if any) survives.
	if _, err := tx.Exec(ctx, `
UPDATE unattributed_deposits AS u
   SET acknowledged_at = NOW(),
       note            = TRIM(BOTH ' | ' FROM COALESCE(u.note, '') || ' | claimed by deposit_intent ' || $1::TEXT)
  FROM deposit_intents AS d
 WHERE d.id = $1
   AND u.network = d.network
   AND u.tx_hash = d.tx_hash
   AND u.acknowledged_at IS NULL`, id); err != nil {
		return fmt.Errorf("dedup unattributed: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit reject wrong_token: %w", err)
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

	cur, err := currency.NetworkToCurrency(intent.Network)
	if err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `
UPDATE wallets
   SET balance_micro = balance_micro + $2,
       updated_at    = NOW()
 WHERE user_id = $1 AND currency = $3`, intent.UserID, intent.AmountMicro, cur); err != nil {
		return fmt.Errorf("credit wallet: %w", err)
	}

	if _, err := tx.Exec(ctx, `
INSERT INTO wallet_ledger (user_id, currency, delta_micro, type, ref_type, ref_id, tx_hash, memo)
VALUES ($1, $5, $2, 'deposit', 'deposit_intent', $3, $4, NULL)
ON CONFLICT (type, ref_type, ref_id) WHERE ref_id IS NOT NULL DO NOTHING`,
		intent.UserID, intent.AmountMicro, intent.ID, intent.TxHash, cur); err != nil {
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
	q := `SELECT ` + intentColumns + ` FROM deposit_intents WHERE id = $1`
	var p PendingIntent
	if err := scanIntent(s.pool.QueryRow(ctx, q, id), &p); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return p, fmt.Errorf("intent_not_found")
		}
		return p, fmt.Errorf("intent by id: %w", err)
	}
	return p, nil
}

// UnattributedDeposit is a Transfer to the receive address from a
// non-USDC contract. Filled by the wider eth_getLogs scan and surfaced
// in the admin Unattributed tab. Symbol / decimals may be empty when
// the contract's metadata calls failed — admin still sees the contract
// address + raw uint256 amount.
type UnattributedDeposit struct {
	Network            string
	TxHash             string
	LogIndex           int
	BlockNumber        int64
	BlockHash          string
	From               string
	To                 string
	TokenContract      string
	TokenSymbol        string // empty = unknown
	TokenDecimals      int
	TokenDecimalsKnown bool
	AmountRaw          string // decimal-string uint256
}

// InsertUnattributedDeposit records a wrong-token Transfer to the
// receive address. Idempotent on (network, tx_hash, log_index) so
// multi-Transfer txs don't collide and re-scans of the same block
// range are no-ops.
//
// Skips insertion when a deposit_intent with the same (network,
// tx_hash) already exists — that path will set failure_reason =
// 'wrong_token' on the intent and surface the same incident in the
// Wrong-Token tab, so we don't double-alert.
func (s *Store) InsertUnattributedDeposit(ctx context.Context, d UnattributedDeposit) error {
	var sym any
	if d.TokenSymbol != "" {
		sym = d.TokenSymbol
	}
	var dec any
	if d.TokenDecimalsKnown {
		dec = d.TokenDecimals
	}
	_, err := s.pool.Exec(ctx, `
INSERT INTO unattributed_deposits
  (network, tx_hash, log_index, block_number, block_hash,
   from_address, to_address, token_contract,
   token_symbol, token_decimals, amount_raw)
SELECT $1::chain_network, $2, $3, $4, $5,
       $6, $7, $8,
       $9, $10, $11::NUMERIC
 WHERE NOT EXISTS (
   SELECT 1 FROM deposit_intents
    WHERE network = $1::chain_network AND tx_hash = $2
 )
ON CONFLICT (network, tx_hash, log_index) DO NOTHING`,
		d.Network, strings.ToLower(d.TxHash), d.LogIndex, d.BlockNumber, strings.ToLower(d.BlockHash),
		strings.ToLower(d.From), strings.ToLower(d.To), strings.ToLower(d.TokenContract),
		sym, dec, d.AmountRaw,
	)
	if err != nil {
		return fmt.Errorf("insert unattributed deposit: %w", err)
	}
	return nil
}

// HasDepositIntentFor returns true when a deposit_intent already
// claims this (network, tx_hash). Used by the discovery loop to skip
// inserting an unattributed row that's already represented by an
// intent — avoiding the double-alert.
func (s *Store) HasDepositIntentFor(ctx context.Context, network, txHash string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM deposit_intents
   WHERE network = $1::chain_network AND tx_hash = $2
)`, network, strings.ToLower(txHash)).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("has intent: %w", err)
	}
	return exists, nil
}

