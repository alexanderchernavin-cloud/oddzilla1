// DB operations for the bet-delay worker. Each promotion/rejection runs
// as one transaction so the wallet state stays consistent with the
// ticket state.

package store

import (
	"context"
	"errors"
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
	ID                  string
	UserID              string
	Currency            string
	BetType             string
	StakeMicro          int64
	PotentialPayoutMicro int64
	NotBeforeTs         time.Time
	// Bettor opt-in (migration 0053). When true and the worker detects
	// per-leg drift, accept the ticket at the latest published odds
	// instead of rejecting. Single + combo only; the API gates this at
	// placement time, so the worker can treat the column as authoritative.
	AcceptOddsChanges bool
	// Frozen bet_meta payload — needed at re-pricing time to preserve a
	// combi-boost multiplier across the new-odds path. Null when no
	// product-specific metadata was attached.
	BetMetaJSON []byte
}

// ListReady returns ticket ids whose delay expired. Caller must lock each
// row (FOR UPDATE SKIP LOCKED) inside a transaction when actually acting
// on them — prevents two workers from grabbing the same row.
func (s *Store) ListReady(ctx context.Context, limit int) ([]PendingTicket, error) {
	const q = `
SELECT id, user_id, currency, bet_type::text, stake_micro, potential_payout_micro,
       not_before_ts, accept_odds_changes, bet_meta
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
		if err := rows.Scan(
			&t.ID, &t.UserID, &t.Currency, &t.BetType, &t.StakeMicro,
			&t.PotentialPayoutMicro, &t.NotBeforeTs, &t.AcceptOddsChanges,
			&t.BetMetaJSON,
		); err != nil {
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
	if errors.Is(err, pgx.ErrNoRows) {
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

// UpdatedLegOdds is one ticket_selections row whose odds_at_placement
// needs to be rewritten to the latest published price. Caller picks them
// out of the LoadSelections result.
type UpdatedLegOdds struct {
	MarketID  int64
	OutcomeID string
	NewOdds   string
}

// AcceptWithUpdatedOdds is the accept-odds-changes path. Rewrites each
// ticket_selections.odds_at_placement to the supplied current published
// price, updates tickets.potential_payout_micro to the recomputed value,
// promotes the ticket to 'accepted', and adjusts the riskzilla bank
// state's open_liability_micro by the (new - old) potential payout delta
// so the cached counter stays consistent with the sum of open tickets.
// Single + combo only — caller (the worker's evaluate) already gates by
// bet_type.
func AcceptWithUpdatedOdds(
	ctx context.Context,
	tx pgx.Tx,
	ticketID string,
	oldPayoutMicro int64,
	newPayoutMicro int64,
	legs []UpdatedLegOdds,
) error {
	for _, l := range legs {
		if _, err := tx.Exec(ctx, `
UPDATE ticket_selections
   SET odds_at_placement = $3::numeric
 WHERE ticket_id = $1
   AND market_id = $2
   AND outcome_id = $4`, ticketID, l.MarketID, l.NewOdds, l.OutcomeID); err != nil {
			return fmt.Errorf("update leg odds: %w", err)
		}
	}
	if _, err := tx.Exec(ctx, `
UPDATE tickets
   SET status                = 'accepted',
       accepted_at            = NOW(),
       potential_payout_micro = $2
 WHERE id = $1`, ticketID, newPayoutMicro); err != nil {
		return fmt.Errorf("accept ticket with new odds: %w", err)
	}
	// Keep the riskzilla bank state in sync. The placement path bumped
	// open_liability_micro by oldPayoutMicro; settlement will decrement
	// by the ticket's current potential_payout_micro (== newPayoutMicro)
	// — so without this delta the counter would drift by
	// (newPayoutMicro - oldPayoutMicro) until the next recompute. The
	// table is a singleton (id=1) but we don't depend on the literal
	// here in case the row layout changes.
	delta := newPayoutMicro - oldPayoutMicro
	if delta != 0 {
		if _, err := tx.Exec(ctx, `
UPDATE riskzilla_bank_state
   SET open_liability_micro = open_liability_micro + $1`, delta); err != nil {
			return fmt.Errorf("bank state delta: %w", err)
		}
	}
	return nil
}

// RejectAndRefund rejects the ticket, unlocks the stake on the
// (user_id, currency) wallet, and writes a compensating wallet_ledger row
// keyed so replaying is safe.
func RejectAndRefund(ctx context.Context, tx pgx.Tx, ticketID, userID, currency, reason string, stakeMicro int64) error {
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
   SET locked_micro = locked_micro - $3,
       updated_at   = NOW()
 WHERE user_id = $1 AND currency = $2`, userID, currency, stakeMicro); err != nil {
		return fmt.Errorf("unlock stake: %w", err)
	}
	// Unique partial index on (type, ref_type, ref_id) ensures this
	// refund cannot double-post if we crash + replay.
	if _, err := tx.Exec(ctx, `
INSERT INTO wallet_ledger (user_id, currency, delta_micro, type, ref_type, ref_id, memo)
VALUES ($1, $2, $3, 'bet_refund', 'ticket', $4, $5)
ON CONFLICT (type, ref_type, ref_id) WHERE ref_id IS NOT NULL DO NOTHING`,
		userID, currency, stakeMicro, ticketID, reason); err != nil {
		return fmt.Errorf("ledger refund: %w", err)
	}
	return nil
}
