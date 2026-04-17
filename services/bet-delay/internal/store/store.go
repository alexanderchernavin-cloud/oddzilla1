// DB operations for the bet-delay worker. Each promotion/rejection runs
// as one transaction so the wallet state stays consistent with the
// ticket state.

package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// PendingTicket is the minimal info needed to re-validate a ticket.
type PendingTicket struct {
	ID          string
	UserID      string
	StakeMicro  int64
	NotBeforeTs time.Time
}

// ListReady returns ticket ids whose delay expired. Caller must lock each
// row (FOR UPDATE SKIP LOCKED) inside a transaction when actually acting
// on them — prevents two workers from grabbing the same row.
func (s *Store) ListReady(ctx context.Context, limit int) ([]PendingTicket, error) {
	const q = `
SELECT id, user_id, stake_micro, not_before_ts
  FROM tickets
 WHERE status = 'pending_delay'
   AND not_before_ts <= NOW()
 ORDER BY not_before_ts
 LIMIT $1`
	rows, err := s.pool.Query(ctx, q, limit)
	if err != nil {
		return nil, fmt.Errorf("list ready: %w", err)
	}
	defer rows.Close()

	out := make([]PendingTicket, 0, limit)
	for rows.Next() {
		var t PendingTicket
		if err := rows.Scan(&t.ID, &t.UserID, &t.StakeMicro, &t.NotBeforeTs); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// Selection is one row from ticket_selections + the current published
// odds + market status at re-validation time.
type Selection struct {
	MarketID          int64
	OutcomeID         string
	OddsAtPlacement   string
	CurrentPublished  *string // nil = no price available right now
	OutcomeActive     bool
	MarketStatus      int16
}

// LoadSelections runs under the ticket's SELECT FOR UPDATE lock.
func LoadSelections(ctx context.Context, tx pgx.Tx, ticketID string) ([]Selection, error) {
	const q = `
SELECT ts.market_id,
       ts.outcome_id,
       ts.odds_at_placement::text,
       mo.published_odds::text,
       mo.active,
       m.status
  FROM ticket_selections ts
  JOIN markets m          ON m.id = ts.market_id
  LEFT JOIN market_outcomes mo
         ON mo.market_id = ts.market_id AND mo.outcome_id = ts.outcome_id
 WHERE ts.ticket_id = $1`
	rows, err := tx.Query(ctx, q, ticketID)
	if err != nil {
		return nil, fmt.Errorf("load selections: %w", err)
	}
	defer rows.Close()

	out := make([]Selection, 0, 4)
	for rows.Next() {
		var s Selection
		var published *string
		if err := rows.Scan(&s.MarketID, &s.OutcomeID, &s.OddsAtPlacement, &published, &s.OutcomeActive, &s.MarketStatus); err != nil {
			return nil, err
		}
		s.CurrentPublished = published
		out = append(out, s)
	}
	return out, rows.Err()
}

// Lock tries to advisory-lock the ticket row. Returns the ticket's current
// status (may have changed since we listed it) and whether we got the lock.
// Caller commits/rolls back the transaction.
func Lock(ctx context.Context, tx pgx.Tx, ticketID string) (status string, ok bool, err error) {
	// SKIP LOCKED lets other workers move on to other tickets.
	err = tx.QueryRow(ctx, `
SELECT status FROM tickets
 WHERE id = $1
   FOR UPDATE SKIP LOCKED`, ticketID).Scan(&status)
	if err == pgx.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return status, true, nil
}

// Accept promotes the ticket to 'accepted' and sets accepted_at.
func Accept(ctx context.Context, tx pgx.Tx, ticketID string) error {
	_, err := tx.Exec(ctx, `
UPDATE tickets
   SET status = 'accepted',
       accepted_at = NOW()
 WHERE id = $1`, ticketID)
	if err != nil {
		return fmt.Errorf("accept ticket: %w", err)
	}
	return nil
}

// RejectAndRefund rejects the ticket, unlocks the stake, and writes a
// compensating wallet_ledger row keyed so replaying is safe.
func RejectAndRefund(ctx context.Context, tx pgx.Tx, ticketID, userID, reason string, stakeMicro int64) error {
	if _, err := tx.Exec(ctx, `
UPDATE tickets
   SET status = 'rejected',
       reject_reason = $2,
       settled_at = NOW()
 WHERE id = $1`, ticketID, reason); err != nil {
		return fmt.Errorf("reject ticket: %w", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE wallets
   SET locked_micro = locked_micro - $2,
       updated_at   = NOW()
 WHERE user_id = $1`, userID, stakeMicro); err != nil {
		return fmt.Errorf("unlock stake: %w", err)
	}
	// Unique partial index on (type, ref_type, ref_id) ensures this
	// refund cannot double-post if we crash + replay.
	if _, err := tx.Exec(ctx, `
INSERT INTO wallet_ledger (user_id, delta_micro, type, ref_type, ref_id, memo)
VALUES ($1, $2, 'bet_refund', 'ticket', $3, $4)
ON CONFLICT (type, ref_type, ref_id) WHERE ref_id IS NOT NULL DO NOTHING`,
		userID, stakeMicro, ticketID, reason); err != nil {
		return fmt.Errorf("ledger refund: %w", err)
	}
	return nil
}
