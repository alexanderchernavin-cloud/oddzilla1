package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/oddzilla/slotzilla/internal/rules"
)

// riskzillaCurrency: RiskZilla's bank bookkeeping is USDC-only. OZ is the
// demo currency and carries no operator risk, so its spins never touch
// open_liability_micro — in EITHER direction (an unguarded increment
// would inject a balance no decrement could remove; see CLAUDE.md).
const riskzillaCurrency = "USDC"

// ledgerRefType is wallet_ledger.ref_type for every SlotZilla row; ref_id
// is the spin uuid, so a replayed settlement is a no-op at the row level.
const ledgerRefType = "slotzilla_spin"

// Spin is an open slotzilla_spins row as the settler reads it.
type Spin struct {
	ID            string
	UserID        string
	MatchID       int64
	Currency      string // trimmed
	StakeMicro    int64
	ExposureMicro int64
	PaytableID    int64
	WindowFrom    int
	Autoplay      bool
	PlacedAt      time.Time
}

// Currency is CHAR(4) and comes back padded; TRIM in SQL so every
// comparison in Go sees 'USDC', not 'USDC' with a trailing space.
const sqlOpenSpins = `
SELECT id::text, user_id::text, match_id, TRIM(currency), stake_micro, exposure_micro, paytable_id,
       window_from, autoplay, placed_at
  FROM slotzilla_spins
 WHERE match_id = $1 AND status = 'open'
 ORDER BY placed_at, id`

// OpenSpins lists the open spins on a game, oldest first.
func (s *Store) OpenSpins(ctx context.Context, matchID int64) ([]Spin, error) {
	rows, err := s.pool.Query(ctx, sqlOpenSpins, matchID)
	if err != nil {
		return nil, fmt.Errorf("open spins %d: %w", matchID, err)
	}
	defer rows.Close()
	var out []Spin
	for rows.Next() {
		var sp Spin
		if err := rows.Scan(&sp.ID, &sp.UserID, &sp.MatchID, &sp.Currency, &sp.StakeMicro, &sp.ExposureMicro, &sp.PaytableID,
			&sp.WindowFrom, &sp.Autoplay, &sp.PlacedAt); err != nil {
			return nil, fmt.Errorf("scan spin: %w", err)
		}
		sp.Currency = strings.TrimSpace(sp.Currency)
		out = append(out, sp)
	}
	return out, rows.Err()
}

const sqlCountOpenSpins = `SELECT COUNT(*) FROM slotzilla_spins WHERE status = 'open'`

// CountOpenSpins is the status-hash figure.
func (s *Store) CountOpenSpins(ctx context.Context) (int64, error) {
	var n int64
	if err := s.pool.QueryRow(ctx, sqlCountOpenSpins).Scan(&n); err != nil {
		return 0, fmt.Errorf("count open spins: %w", err)
	}
	return n, nil
}

// Settlement is the frozen result of a spin.
type Settlement struct {
	Reels          [3]rules.Symbol
	Teams          [3]string // "" = NULL
	EventIDs       [3]*int64
	LineKey        string // "" = NULL
	MultiplierX100 int
	PayoutMicro    int64
	// Status is 'won' when the line paid, 'lost' otherwise.
	Status string
}

const sqlSettleSpin = `
UPDATE slotzilla_spins
   SET status = $2,
       reels = $3,
       reel_teams = $4,
       reel_event_ids = $5,
       line_key = $6,
       multiplier_x100 = $7,
       payout_micro = $8,
       settled_at = now()
 WHERE id = $1 AND status = 'open'`

func settleSpinRow(ctx context.Context, tx runner, spinID string, st Settlement) (bool, error) {
	reels := []string{string(st.Reels[0]), string(st.Reels[1]), string(st.Reels[2])}
	teams := []*string{nullString(st.Teams[0]), nullString(st.Teams[1]), nullString(st.Teams[2])}
	ids := []*int64{st.EventIDs[0], st.EventIDs[1], st.EventIDs[2]}
	tag, err := tx.Exec(ctx, sqlSettleSpin, spinID, st.Status, reels, teams, ids, nullString(st.LineKey), st.MultiplierX100, st.PayoutMicro)
	if err != nil {
		return false, fmt.Errorf("settle spin row: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// Settle: the lock is released and the balance moves by (payout - stake),
// on the (user, currency) wallet row and no other.
const sqlReleaseStakeOnSettle = `
UPDATE wallets
   SET locked_micro = locked_micro - $3,
       balance_micro = balance_micro + ($4 - $3),
       updated_at = now()
 WHERE user_id = $1 AND currency = $2`

func releaseStakeOnSettle(ctx context.Context, tx runner, userID, currency string, stakeMicro, payoutMicro int64) error {
	if _, err := tx.Exec(ctx, sqlReleaseStakeOnSettle, userID, currency, stakeMicro, payoutMicro); err != nil {
		return fmt.Errorf("wallet settle update: %w", err)
	}
	return nil
}

// Void: the lock is released and the balance is unchanged.
const sqlReleaseStakeOnVoid = `
UPDATE wallets
   SET locked_micro = locked_micro - $3,
       updated_at = now()
 WHERE user_id = $1 AND currency = $2`

func releaseStakeOnVoid(ctx context.Context, tx runner, userID, currency string, stakeMicro int64) error {
	if _, err := tx.Exec(ctx, sqlReleaseStakeOnVoid, userID, currency, stakeMicro); err != nil {
		return fmt.Errorf("wallet void update: %w", err)
	}
	return nil
}

// Apply-once credit (invariant 4): the unique partial index on
// (type, ref_type, ref_id) makes a second insert for the same spin a
// no-op.
const sqlInsertLedger = `
INSERT INTO wallet_ledger (user_id, currency, delta_micro, type, ref_type, ref_id, memo)
VALUES ($1, $2, $3, $4::wallet_tx_type, $5, $6, $7)
ON CONFLICT (type, ref_type, ref_id) WHERE ref_id IS NOT NULL DO NOTHING`

func insertLedger(ctx context.Context, tx runner, userID, currency string, deltaMicro int64, ledgerType, spinID, memo string) error {
	if _, err := tx.Exec(ctx, sqlInsertLedger, userID, currency, deltaMicro, ledgerType, ledgerRefType, spinID, memo); err != nil {
		return fmt.Errorf("ledger %s insert: %w", ledgerType, err)
	}
	return nil
}

// The api added the spin's capped exposure at placement; settle and void
// both release it. GREATEST(0, ...) mirrors settlement's decrement.
const sqlReleaseOpenLiability = `
UPDATE riskzilla_bank_state
   SET open_liability_micro = GREATEST(0, open_liability_micro - $1::bigint),
       updated_at = now()
 WHERE id = 'default'`

func releaseOpenLiability(ctx context.Context, tx runner, currency string, exposureMicro int64) error {
	if strings.TrimSpace(currency) != riskzillaCurrency || exposureMicro <= 0 {
		return nil
	}
	if _, err := tx.Exec(ctx, sqlReleaseOpenLiability, exposureMicro); err != nil {
		return fmt.Errorf("riskzilla open_liability release: %w", err)
	}
	return nil
}

// Return-monitor totals, per currency, on the game row.
const sqlAddGamePayout = `
UPDATE slotzilla_games
   SET usdc_payout_micro = usdc_payout_micro + CASE WHEN $2 = 'USDC' THEN $3::bigint ELSE 0 END,
       oz_payout_micro = oz_payout_micro + CASE WHEN $2 = 'OZ' THEN $3::bigint ELSE 0 END,
       updated_at = now()
 WHERE match_id = $1`

func addGamePayout(ctx context.Context, tx runner, matchID int64, currency string, payoutMicro int64) error {
	if _, err := tx.Exec(ctx, sqlAddGamePayout, matchID, strings.TrimSpace(currency), payoutMicro); err != nil {
		return fmt.Errorf("game payout total: %w", err)
	}
	return nil
}

// A voided stake leaves the return monitor's denominator.
const sqlSubtractGameStake = `
UPDATE slotzilla_games
   SET usdc_stake_micro = usdc_stake_micro - CASE WHEN $2 = 'USDC' THEN $3::bigint ELSE 0 END,
       oz_stake_micro = oz_stake_micro - CASE WHEN $2 = 'OZ' THEN $3::bigint ELSE 0 END,
       updated_at = now()
 WHERE match_id = $1`

func subtractGameStake(ctx context.Context, tx runner, matchID int64, currency string, stakeMicro int64) error {
	if _, err := tx.Exec(ctx, sqlSubtractGameStake, matchID, strings.TrimSpace(currency), stakeMicro); err != nil {
		return fmt.Errorf("game stake total: %w", err)
	}
	return nil
}

const sqlVoidSpin = `
UPDATE slotzilla_spins
   SET status = 'void', void_reason = $2, settled_at = now()
 WHERE id = $1 AND status = 'open'`

func voidSpinRow(ctx context.Context, tx runner, spinID, reason string) (bool, error) {
	tag, err := tx.Exec(ctx, sqlVoidSpin, spinID, reason)
	if err != nil {
		return false, fmt.Errorf("void spin row: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// SettleSpin applies one spin's result in ONE transaction, exactly per
// the money rules: the row is frozen (guarded on status = 'open' — a
// concurrent void or an admin action wins and this returns false), the
// wallet releases the lock and moves by (payout - stake), a slot_payout
// ledger row is written when anything was paid, RiskZilla's open
// liability is released for USDC, and the game's payout total grows.
func (s *Store) SettleSpin(ctx context.Context, sp Spin, st Settlement) (bool, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, fmt.Errorf("begin settle tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after Commit

	ok, err := settleSpinRow(ctx, tx, sp.ID, st)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, nil
	}
	if err := releaseStakeOnSettle(ctx, tx, sp.UserID, sp.Currency, sp.StakeMicro, st.PayoutMicro); err != nil {
		return false, err
	}
	if st.PayoutMicro > 0 {
		memo := fmt.Sprintf("slotzilla %s x%s", st.LineKey, rules.FormatMultiplier(st.MultiplierX100))
		if err := insertLedger(ctx, tx, sp.UserID, sp.Currency, st.PayoutMicro, "slot_payout", sp.ID, memo); err != nil {
			return false, err
		}
	}
	if err := releaseOpenLiability(ctx, tx, sp.Currency, sp.ExposureMicro); err != nil {
		return false, err
	}
	if err := addGamePayout(ctx, tx, sp.MatchID, sp.Currency, st.PayoutMicro); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit settle tx: %w", err)
	}
	return true, nil
}

// VoidSpin refunds one open spin in ONE transaction: the row is voided
// with its reason (guarded on status = 'open'), the lock is released with
// the balance unchanged, a slot_refund ledger row records it, RiskZilla's
// open liability is released for USDC, and the stake leaves the game's
// total so the return monitor does not count a refund as a loss.
func (s *Store) VoidSpin(ctx context.Context, sp Spin, reason string) (bool, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, fmt.Errorf("begin void tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after Commit

	ok, err := voidSpinRow(ctx, tx, sp.ID, reason)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, nil
	}
	if err := releaseStakeOnVoid(ctx, tx, sp.UserID, sp.Currency, sp.StakeMicro); err != nil {
		return false, err
	}
	if err := insertLedger(ctx, tx, sp.UserID, sp.Currency, sp.StakeMicro, "slot_refund", sp.ID, "slotzilla void: "+reason); err != nil {
		return false, err
	}
	if err := releaseOpenLiability(ctx, tx, sp.Currency, sp.ExposureMicro); err != nil {
		return false, err
	}
	if err := subtractGameStake(ctx, tx, sp.MatchID, sp.Currency, sp.StakeMicro); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit void tx: %w", err)
	}
	return true, nil
}
