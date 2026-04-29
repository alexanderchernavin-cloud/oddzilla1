// Postgres store for settlement. Pure queries; no side effects on Redis
// or AMQP. Callers compose these inside a transaction that spans one
// incoming XML message.

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

// BeginTx starts a read-committed transaction.
func (s *Store) BeginTx(ctx context.Context) (pgx.Tx, error) {
	return s.pool.Begin(ctx)
}

// ─── Apply-once settlement insert ──────────────────────────────────────────

// SettlementInsert is one market-worth of settlement action. A single
// Oddin XML message typically contains several of these.
type SettlementInsert struct {
	EventURN        string
	MarketID        int64
	SpecifiersHash  []byte
	Type            string // 'settle' | 'cancel' | 'rollback_settle' | 'rollback_cancel'
	PayloadHash     []byte
	PayloadJSON     []byte // stringified JSON, written to JSONB column
}

// InsertIfNew inserts the settlements row. Returns (id, true) on fresh
// insert, (0, false) if the row already existed (replay).
func InsertIfNew(ctx context.Context, tx pgx.Tx, in SettlementInsert) (int64, bool, error) {
	const q = `
INSERT INTO settlements (event_urn, market_id, specifiers_hash, type, payload_hash, payload_json)
VALUES ($1, $2, $3, $4::settlement_type, $5, $6::jsonb)
ON CONFLICT (event_urn, market_id, specifiers_hash, type, payload_hash)
DO NOTHING
RETURNING id`
	var id int64
	err := tx.QueryRow(ctx, q,
		in.EventURN, in.MarketID, in.SpecifiersHash, in.Type, in.PayloadHash, string(in.PayloadJSON),
	).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("insert settlement: %w", err)
	}
	return id, true, nil
}

// ─── Market / outcome lookups ──────────────────────────────────────────────

// FindMarket returns the market id for the (event_urn, provider_market_id,
// specifiers_hash) triple. Returns (0, false, nil) when the market is
// unknown — the settlement message references something we haven't ingested.
func FindMarket(ctx context.Context, tx pgx.Tx, eventURN string, providerMarketID int, specifiersHash []byte) (int64, bool, error) {
	const q = `
SELECT m.id
  FROM markets m
  JOIN matches ma ON ma.id = m.match_id
 WHERE ma.provider_urn = $1
   AND m.provider_market_id = $2
   AND m.specifiers_hash = $3`
	var id int64
	err := tx.QueryRow(ctx, q, eventURN, providerMarketID, specifiersHash).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("find market: %w", err)
	}
	return id, true, nil
}

// SetMarketStatus updates the market.status column (used for -3 settled / -4 cancelled).
func SetMarketStatus(ctx context.Context, tx pgx.Tx, marketID int64, status int16, oddinTs int64) error {
	_, err := tx.Exec(ctx, `
UPDATE markets
   SET status = $2,
       last_oddin_ts = GREATEST(last_oddin_ts, $3),
       updated_at = NOW()
 WHERE id = $1`, marketID, int(status), oddinTs)
	if err != nil {
		return fmt.Errorf("set market status: %w", err)
	}
	return nil
}

// UpdateOutcomeResult sets (result, void_factor) on one market_outcomes row.
func UpdateOutcomeResult(ctx context.Context, tx pgx.Tx, marketID int64, outcomeID, result string, voidFactor string, oddinTs int64) error {
	// result may be "" (for pure-void via void_factor=1); we only update
	// result when non-empty so we don't blow away a prior "won" with NULL
	// on a cancel that semantically means refund-everyone.
	var q string
	var args []any
	if result != "" {
		q = `
UPDATE market_outcomes
   SET result = $3::outcome_result,
       void_factor = NULLIF($4, '')::numeric,
       last_oddin_ts = GREATEST(last_oddin_ts, $5),
       updated_at = NOW()
 WHERE market_id = $1 AND outcome_id = $2`
		args = []any{marketID, outcomeID, result, voidFactor, oddinTs}
	} else {
		q = `
UPDATE market_outcomes
   SET result = 'void'::outcome_result,
       void_factor = 1,
       last_oddin_ts = GREATEST(last_oddin_ts, $3),
       updated_at = NOW()
 WHERE market_id = $1 AND outcome_id = $2`
		args = []any{marketID, outcomeID, oddinTs}
	}
	if _, err := tx.Exec(ctx, q, args...); err != nil {
		return fmt.Errorf("update outcome result: %w", err)
	}
	return nil
}

// ─── Ticket selection affect ───────────────────────────────────────────────

// AffectedTicket represents a ticket that currently has at least one
// selection on the market we just settled.
type AffectedTicket struct {
	TicketID string
}

// AffectedTicketsForMarket returns the IDs of tickets that have any
// selection on this market (regardless of settled state). Used by
// handlers to decide which tickets might need resettling.
func AffectedTicketsForMarket(ctx context.Context, tx pgx.Tx, marketID int64) ([]string, error) {
	rows, err := tx.Query(ctx, `
SELECT DISTINCT ticket_id
  FROM ticket_selections
 WHERE market_id = $1`, marketID)
	if err != nil {
		return nil, fmt.Errorf("affected tickets: %w", err)
	}
	defer rows.Close()
	out := make([]string, 0, 8)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ApplyOutcomeToSelections writes result + void_factor onto any
// ticket_selections row still unresolved for this (market, outcome). The
// table's partial index `WHERE result IS NULL` makes the scan cheap.
func ApplyOutcomeToSelections(ctx context.Context, tx pgx.Tx, marketID int64, outcomeID, result, voidFactor string) error {
	var q string
	var args []any
	if result != "" {
		q = `
UPDATE ticket_selections
   SET result = $3::outcome_result,
       void_factor = NULLIF($4, '')::numeric,
       settled_at = NOW()
 WHERE market_id = $1 AND outcome_id = $2 AND result IS NULL`
		args = []any{marketID, outcomeID, result, voidFactor}
	} else {
		q = `
UPDATE ticket_selections
   SET result = 'void'::outcome_result,
       void_factor = 1,
       settled_at = NOW()
 WHERE market_id = $1 AND outcome_id = $2 AND result IS NULL`
		args = []any{marketID, outcomeID}
	}
	if _, err := tx.Exec(ctx, q, args...); err != nil {
		return fmt.Errorf("apply outcome to selections: %w", err)
	}
	return nil
}

// VoidSelectionsForMarket marks every unresolved selection on a market
// as void (result=void, void_factor=1) — used by bet_cancel when the
// whole market is voided. Optionally scoped by ticket placement window:
//   - startMs only: void selections from tickets placed AT/AFTER startMs
//   - endMs only:   void selections from tickets placed AT/BEFORE endMs
//   - both:         void selections from tickets placed within the range
//   - neither:      void every unresolved selection on the market
// The placed_at filter joins through tickets so combo bets work correctly
// once we add them.
func VoidSelectionsForMarket(ctx context.Context, tx pgx.Tx, marketID int64, startMs, endMs *int64) error {
	const q = `
UPDATE ticket_selections ts
   SET result = 'void'::outcome_result,
       void_factor = 1,
       settled_at = NOW()
  FROM tickets t
 WHERE ts.ticket_id = t.id
   AND ts.market_id = $1
   AND ts.result IS NULL
   AND ($2::bigint IS NULL OR (EXTRACT(EPOCH FROM t.placed_at) * 1000)::bigint >= $2)
   AND ($3::bigint IS NULL OR (EXTRACT(EPOCH FROM t.placed_at) * 1000)::bigint <= $3)`
	if _, err := tx.Exec(ctx, q, marketID, nullableInt64(startMs), nullableInt64(endMs)); err != nil {
		return fmt.Errorf("void selections: %w", err)
	}
	return nil
}

// AffectedTicketsForMarketInWindow returns ticket IDs that touch the
// market AND fall within the optional placed_at window. Used by the
// time-windowed bet_cancel path so cancel-after-settle reversal only
// touches tickets the cancel actually applies to.
func AffectedTicketsForMarketInWindow(ctx context.Context, tx pgx.Tx, marketID int64, startMs, endMs *int64) ([]string, error) {
	const q = `
SELECT DISTINCT ts.ticket_id
  FROM ticket_selections ts
  JOIN tickets t ON t.id = ts.ticket_id
 WHERE ts.market_id = $1
   AND ($2::bigint IS NULL OR (EXTRACT(EPOCH FROM t.placed_at) * 1000)::bigint >= $2)
   AND ($3::bigint IS NULL OR (EXTRACT(EPOCH FROM t.placed_at) * 1000)::bigint <= $3)`
	rows, err := tx.Query(ctx, q, marketID, nullableInt64(startMs), nullableInt64(endMs))
	if err != nil {
		return nil, fmt.Errorf("affected tickets in window: %w", err)
	}
	defer rows.Close()
	out := make([]string, 0, 8)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// VoidSelectionsForTicketOnMarket voids the selections of one ticket on
// one market. Used by the time-windowed cancel path which loops per
// ticket rather than batching across the whole market.
func VoidSelectionsForTicketOnMarket(ctx context.Context, tx pgx.Tx, ticketID string, marketID int64) error {
	_, err := tx.Exec(ctx, `
UPDATE ticket_selections
   SET result = 'void'::outcome_result,
       void_factor = 1,
       settled_at = NOW()
 WHERE ticket_id = $1 AND market_id = $2 AND result IS NULL`, ticketID, marketID)
	if err != nil {
		return fmt.Errorf("void selections per ticket: %w", err)
	}
	return nil
}

// ReverseSelectionsForTicketOnMarket clears prior result/void_factor on
// one ticket's selections for one market — paired with
// VoidSelectionsForTicketOnMarket inside the cancel-after-settle flow.
func ReverseSelectionsForTicketOnMarket(ctx context.Context, tx pgx.Tx, ticketID string, marketID int64) error {
	_, err := tx.Exec(ctx, `
UPDATE ticket_selections
   SET result = NULL, void_factor = NULL, settled_at = NULL
 WHERE ticket_id = $1 AND market_id = $2`, ticketID, marketID)
	if err != nil {
		return fmt.Errorf("reverse selections per ticket: %w", err)
	}
	return nil
}

func nullableInt64(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

// ─── Ticket resolution ─────────────────────────────────────────────────────

// TicketForSettle is everything we need to compute payout + update wallet.
// Currency identifies which (user_id, currency) wallet row to update;
// every wallet/ledger query in the settlement flow is scoped by this.
type TicketForSettle struct {
	ID                   string
	UserID               string
	Currency             string
	Status               string
	BetType              string
	StakeMicro           int64
	PotentialPayoutMicro int64
	// Raw bet_meta JSONB. NULL for single/combo, populated for tiple/tippot
	// with the schedule frozen at placement. Settlement parses it
	// per-bet-type — see services/settlement/internal/settler/payout.go.
	BetMetaJSON []byte
}

// LoadTicketForSettle FOR UPDATEs the ticket row inside the caller's tx.
// Returns (ticket, false, nil) on SKIP LOCKED miss — another worker has it.
func LoadTicketForSettle(ctx context.Context, tx pgx.Tx, ticketID string) (TicketForSettle, bool, error) {
	var t TicketForSettle
	err := tx.QueryRow(ctx, `
SELECT id, user_id, currency, status::text, bet_type::text, stake_micro, potential_payout_micro, bet_meta
  FROM tickets
 WHERE id = $1
   FOR UPDATE SKIP LOCKED`, ticketID).Scan(
		&t.ID, &t.UserID, &t.Currency, &t.Status, &t.BetType, &t.StakeMicro, &t.PotentialPayoutMicro, &t.BetMetaJSON,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return t, false, nil
		}
		return t, false, fmt.Errorf("load ticket: %w", err)
	}
	return t, true, nil
}

// UnresolvedCount returns how many selections on a ticket still have
// result IS NULL. Zero means we can settle the ticket.
func UnresolvedCount(ctx context.Context, tx pgx.Tx, ticketID string) (int, error) {
	var n int
	if err := tx.QueryRow(ctx, `
SELECT COUNT(*)
  FROM ticket_selections
 WHERE ticket_id = $1 AND result IS NULL`, ticketID).Scan(&n); err != nil {
		return 0, fmt.Errorf("unresolved count: %w", err)
	}
	return n, nil
}

// SelectionResult carries enough to compute payout.
type SelectionResult struct {
	OddsAtPlacement        string
	ProbabilityAtPlacement string // may be empty (single/combo, or pre-Tiple data)
	Result                 string
	VoidFactor             string // may be empty
}

// ResolvedSelections returns each selection's oddsAtPlacement + result.
// Only called for a ticket whose UnresolvedCount = 0.
func ResolvedSelections(ctx context.Context, tx pgx.Tx, ticketID string) ([]SelectionResult, error) {
	rows, err := tx.Query(ctx, `
SELECT odds_at_placement::text,
       COALESCE(probability_at_placement::text, ''),
       COALESCE(result::text, ''),
       COALESCE(void_factor::text, '')
  FROM ticket_selections
 WHERE ticket_id = $1`, ticketID)
	if err != nil {
		return nil, fmt.Errorf("resolved selections: %w", err)
	}
	defer rows.Close()
	out := make([]SelectionResult, 0, 4)
	for rows.Next() {
		var s SelectionResult
		if err := rows.Scan(&s.OddsAtPlacement, &s.ProbabilityAtPlacement, &s.Result, &s.VoidFactor); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// SettleTicket writes the final ticket state, updates the wallet, and
// inserts the payout ledger row. `payoutMicro` is the actual amount
// credited back to the user (stake refund on void, 0 on total loss,
// stake*odds on win, and partials in between).
//
// The wallet_ledger unique partial index on (type, ref_type, ref_id) is
// what makes settlement idempotent under replay — a second call with the
// same key is a no-op. To support the rare-but-real "settle → rollback →
// re-settle with a different result" flow, we suffix ref_id with a
// generation number (`<ticketID>:N`) when a previous payout row already
// exists, so each generation gets its own row instead of being silently
// dropped by ON CONFLICT.
func SettleTicket(ctx context.Context, tx pgx.Tx, t TicketForSettle, payoutMicro int64, ledgerType, memo string) error {
	if _, err := tx.Exec(ctx, `
UPDATE tickets
   SET status = 'settled',
       actual_payout_micro = $2,
       settled_at = NOW()
 WHERE id = $1`, t.ID, payoutMicro); err != nil {
		return fmt.Errorf("update ticket settled: %w", err)
	}

	// Wallet: release the lock, move balance by (payout - stake), scoped
	// to the ticket's currency wallet row.
	if _, err := tx.Exec(ctx, `
UPDATE wallets
   SET locked_micro = locked_micro - $3,
       balance_micro = balance_micro + ($4 - $3),
       updated_at = NOW()
 WHERE user_id = $1 AND currency = $2`, t.UserID, t.Currency, t.StakeMicro, payoutMicro); err != nil {
		return fmt.Errorf("update wallet: %w", err)
	}

	// Ledger: record the payout event. Skip when payoutMicro is zero —
	// there's no credit to audit (and the -stake from placement is the
	// final loss entry). This keeps the unique index clean.
	if payoutMicro > 0 {
		refID, err := nextPayoutRefID(ctx, tx, t.ID, ledgerType)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO wallet_ledger (user_id, currency, delta_micro, type, ref_type, ref_id, memo)
VALUES ($1, $2, $3, $4::wallet_tx_type, 'ticket', $5, $6)
ON CONFLICT (type, ref_type, ref_id) WHERE ref_id IS NOT NULL DO NOTHING`,
			t.UserID, t.Currency, payoutMicro, ledgerType, refID, memo); err != nil {
			return fmt.Errorf("ledger settle insert: %w", err)
		}
	}
	return nil
}

// nextPayoutRefID returns the ref_id to use for a new ledger row of
// `ledgerType`. The first generation is the bare ticket UUID; subsequent
// generations append ":N" so a re-settle after rollback gets its own row.
func nextPayoutRefID(ctx context.Context, tx pgx.Tx, ticketID, ledgerType string) (string, error) {
	var count int
	err := tx.QueryRow(ctx, `
SELECT COUNT(*) FROM wallet_ledger
 WHERE ref_type = 'ticket'
   AND type = $2::wallet_tx_type
   AND (ref_id = $1 OR ref_id LIKE $1 || ':%')`,
		ticketID, ledgerType,
	).Scan(&count)
	if err != nil {
		return "", fmt.Errorf("next payout ref id: %w", err)
	}
	if count == 0 {
		return ticketID, nil
	}
	return fmt.Sprintf("%s:%d", ticketID, count+1), nil
}

// LatestUnreversedPayoutRefID returns the ref_id of the most recent
// `bet_payout` ledger row for `ticketID` that has NOT been compensated by
// an `adjustment` row sharing the same ref_id. Returns ("", false, nil)
// when no such row exists (either no settle ever happened, the prior
// payout was zero, or every settle has already been reversed).
func LatestUnreversedPayoutRefID(ctx context.Context, tx pgx.Tx, ticketID string) (string, bool, error) {
	var refID string
	err := tx.QueryRow(ctx, `
SELECT ref_id FROM wallet_ledger p
 WHERE p.ref_type = 'ticket'
   AND p.type = 'bet_payout'
   AND (p.ref_id = $1 OR p.ref_id LIKE $1 || ':%')
   AND NOT EXISTS (
       SELECT 1 FROM wallet_ledger r
        WHERE r.ref_type = 'ticket'
          AND r.type = 'adjustment'
          AND r.ref_id = p.ref_id
   )
 ORDER BY p.id DESC
 LIMIT 1`, ticketID).Scan(&refID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("latest unreversed payout: %w", err)
	}
	return refID, true, nil
}

// ─── Rollback support ──────────────────────────────────────────────────────

// ReverseSettledTicket undoes a prior SettleTicket:
//   - ticket: back to accepted, clear actual_payout + settled_at
//   - ticket_selections: for the given (market, outcome), clear result
//   - wallet: reverse the net movement (balance -= (payout - stake), locked += stake)
//   - ledger: insert a compensating 'adjustment' row keyed by (adjustment, ticket, ticketID)
//     — distinct ledger-key type so the unique partial index lets it coexist
//     with the original 'bet_payout' row.
//
// Safe to call when the ticket was already back to 'accepted' — the
// wallet/ledger operations are additive, so we guard with a status check.
func ReverseSettledTicket(ctx context.Context, tx pgx.Tx, ticketID, userID, currency, reason string, stakeMicro, priorPayoutMicro int64) error {
	tag, err := tx.Exec(ctx, `
UPDATE tickets
   SET status = 'accepted',
       actual_payout_micro = NULL,
       settled_at = NULL
 WHERE id = $1 AND status = 'settled'`, ticketID)
	if err != nil {
		return fmt.Errorf("reverse ticket: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return nil // already reversed or never settled under this name
	}

	if _, err := tx.Exec(ctx, `
UPDATE wallets
   SET locked_micro = locked_micro + $3,
       balance_micro = balance_micro - ($4 - $3),
       updated_at = NOW()
 WHERE user_id = $1 AND currency = $2`, userID, currency, stakeMicro, priorPayoutMicro); err != nil {
		return fmt.Errorf("reverse wallet: %w", err)
	}

	if priorPayoutMicro > 0 {
		// Find the ref_id of the bet_payout we're compensating. Using the
		// same ref_id for the adjustment row pairs them up in audit
		// queries and preserves the per-generation invariant introduced
		// by SettleTicket. If no unreversed payout row exists (e.g. the
		// original payout was 0 and we never wrote one) skip the ledger
		// insert — the wallet update above is the full record of the
		// reversal in that edge case.
		refID, found, err := LatestUnreversedPayoutRefID(ctx, tx, ticketID)
		if err != nil {
			return err
		}
		if found {
			if _, err := tx.Exec(ctx, `
INSERT INTO wallet_ledger (user_id, currency, delta_micro, type, ref_type, ref_id, memo)
VALUES ($1, $2, $3, 'adjustment', 'ticket', $4, $5)
ON CONFLICT (type, ref_type, ref_id) WHERE ref_id IS NOT NULL DO NOTHING`,
				userID, currency, -priorPayoutMicro, refID, reason); err != nil {
				return fmt.Errorf("ledger reverse insert: %w", err)
			}
		}
	}
	return nil
}

// ReverseSelectionsForMarket clears result/void_factor on all selections
// on a market — used by rollback_bet_settlement when we must re-open them.
func ReverseSelectionsForMarket(ctx context.Context, tx pgx.Tx, marketID int64) error {
	_, err := tx.Exec(ctx, `
UPDATE ticket_selections
   SET result = NULL,
       void_factor = NULL,
       settled_at = NULL
 WHERE market_id = $1`, marketID)
	if err != nil {
		return fmt.Errorf("reverse selections: %w", err)
	}
	return nil
}

// ─── Admin audit ───────────────────────────────────────────────────────────

func InsertAdminAudit(ctx context.Context, tx pgx.Tx, action, targetType, targetID string, before, after []byte) error {
	_, err := tx.Exec(ctx, `
INSERT INTO admin_audit_log (actor_user_id, action, target_type, target_id, before_json, after_json)
VALUES (NULL, $1, $2, $3, NULLIF($4, '')::jsonb, NULLIF($5, '')::jsonb)`,
		action, targetType, targetID, string(before), string(after))
	if err != nil {
		return fmt.Errorf("insert audit: %w", err)
	}
	return nil
}

// Compile-time assertion: time.Time is the only time type we care about here.
var _ = time.Time{}
