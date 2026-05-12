// Postgres store for settlement. Pure queries; no side effects on Redis
// or AMQP. Callers compose these inside a transaction that spans one
// incoming XML message.

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

// BeginTx starts a read-committed transaction.
func (s *Store) BeginTx(ctx context.Context) (pgx.Tx, error) {
	return s.pool.Begin(ctx)
}

// ─── Match lifecycle ──────────────────────────────────────────────────────

// MarkMatchClosedIfAllMarketsTerminal flips matches.status to 'closed'
// when every market on the match has reached a terminal state — -3
// (settled) or -4 (cancelled). Per Oddin's spec (§2.4.2): "When a
// market or market line is settled with a bet_settlement message, it
// will be automatically removed from all subsequent match odds_change
// messages." So once the last market settles, the match disappears
// from the odds_change stream and a final <sport_event_status
// status="4"> may never arrive. This function is the safety net for
// that case.
//
// The single SQL statement does both checks atomically:
//   - WHERE provider_urn = $1 AND status NOT IN ('closed','cancelled')
//     keeps it forward-only (re-running on an already-terminal match
//     is a no-op).
//   - NOT EXISTS (...) ensures we only close the match when no market
//     remains in 1 / 0 / -1 / -2 — i.e. nothing bettable, suspended,
//     or in handover. If a per-map market settles mid-match the
//     match-winner market keeps the match active, so this won't
//     false-positive.
//
// Returns nil when the row doesn't exist (settlement reached us before
// feed-ingester ingested the fixture) or when either gate skipped the
// update; callers don't need to distinguish these.
func MarkMatchClosedIfAllMarketsTerminal(ctx context.Context, pool *pgxpool.Pool, providerURN string) error {
	_, err := pool.Exec(ctx, `
UPDATE matches
   SET status = 'closed'::match_status, updated_at = NOW()
 WHERE provider_urn = $1
   AND status::text NOT IN ('closed','cancelled')
   AND NOT EXISTS (
     SELECT 1 FROM markets mk
      WHERE mk.match_id = matches.id
        AND mk.status NOT IN (-3, -4)
   )`, providerURN)
	if err != nil {
		return fmt.Errorf("mark match closed if all markets terminal: %w", err)
	}
	return nil
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

// LoadTicketUserMap returns a map[ticketID]userID for the given ticket
// ids in one round trip. The settler uses this to partition tickets by
// owner before fan-out — each user's tickets always land in the same
// worker, so two workers can never race for the same wallet row and
// deadlock on UPDATE wallets (the failure mode PR #273 hit in prod on
// 2026-05-12 with a 66K-ticket settle on match 626479).
//
// Reads `tickets.user_id` directly rather than re-joining through
// `ticket_selections`; the caller already has the unique ticket IDs.
// Tickets and users both use UUID PKs, so the param array is cast to
// `uuid[]` server-side via the canonical Postgres array literal form
// to dodge Drizzle's record-vs-array binding trap (same shape audit H4
// addressed for FEED_STATUSES).
func LoadTicketUserMap(ctx context.Context, tx pgx.Tx, ticketIDs []string) (map[string]string, error) {
	out := make(map[string]string, len(ticketIDs))
	if len(ticketIDs) == 0 {
		return out, nil
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, user_id::text
  FROM tickets
 WHERE id = ANY($1::uuid[])`, ticketIDs)
	if err != nil {
		return nil, fmt.Errorf("load ticket-user map: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var ticketID, userID string
		if err := rows.Scan(&ticketID, &userID); err != nil {
			return nil, err
		}
		out[ticketID] = userID
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

// LoadTicketWithSelections collapses LoadTicketForSettle + UnresolvedCount
// + ResolvedSelections into a single round-trip. The driver of this
// optimisation (audit H6) is the per-ticket settle loop in
// settler.maybeSettleTicket, which previously paid 3 sequential round-
// trips per ticket just to decide whether to settle.
//
// Implementation: the ticket's FOR UPDATE SKIP LOCKED CTE runs first;
// every selection row joins onto it and carries the locked ticket
// columns alongside its own result/void_factor/odds. The caller
// reconstructs both the ticket header and the selection list from one
// rows.Next() walk.
//
// Returns (ticket, selections, locked, err):
//   - locked=false on SKIP LOCKED miss; caller short-circuits as before.
//   - selections always contains every row attached to the ticket
//     (resolved or not); the caller decides what to do based on
//     UnresolvedCount(selections).
//
// The original LoadTicketForSettle / UnresolvedCount / ResolvedSelections
// are intentionally retained — smoke-settle and the cancel/rollback paths
// in settler.go still call them, and changing every call site would
// balloon this PR.
func LoadTicketWithSelections(ctx context.Context, tx pgx.Tx, ticketID string) (TicketForSettle, []SelectionResult, bool, error) {
	const q = `
WITH locked AS (
  SELECT id, user_id, currency, status::text AS status,
         bet_type::text AS bet_type, stake_micro,
         potential_payout_micro, bet_meta
    FROM tickets
   WHERE id = $1
     FOR UPDATE SKIP LOCKED
)
SELECT l.id, l.user_id, l.currency, l.status, l.bet_type,
       l.stake_micro, l.potential_payout_micro, l.bet_meta,
       ts.odds_at_placement::text,
       COALESCE(ts.probability_at_placement::text, ''),
       COALESCE(ts.result::text, ''),
       COALESCE(ts.void_factor::text, '')
  FROM locked l
  LEFT JOIN ticket_selections ts ON ts.ticket_id = l.id`
	rows, err := tx.Query(ctx, q, ticketID)
	if err != nil {
		return TicketForSettle{}, nil, false, fmt.Errorf("load ticket+selections: %w", err)
	}
	defer rows.Close()

	var (
		t    TicketForSettle
		sels = make([]SelectionResult, 0, 4)
		seen bool
	)
	for rows.Next() {
		// Per-row scan targets. The ticket columns are duplicated across
		// every joined row; we copy them once on the first row, then
		// only consume the per-selection columns thereafter. nullable
		// selection columns appear when the LEFT JOIN miss returns a
		// header-only row (ticket exists but has zero selections — not
		// expected under normal flow but defensive).
		var (
			tid, uid, cur, status, betType string
			stake, potential               int64
			betMeta                        []byte
			odds, prob, result, vf         *string
		)
		if err := rows.Scan(
			&tid, &uid, &cur, &status, &betType,
			&stake, &potential, &betMeta,
			&odds, &prob, &result, &vf,
		); err != nil {
			return TicketForSettle{}, nil, false, fmt.Errorf("scan ticket+selections: %w", err)
		}
		if !seen {
			t = TicketForSettle{
				ID: tid, UserID: uid, Currency: cur,
				Status: status, BetType: betType,
				StakeMicro: stake, PotentialPayoutMicro: potential,
				BetMetaJSON: betMeta,
			}
			seen = true
		}
		if odds != nil { // skip the LEFT JOIN sentinel when no selections
			sels = append(sels, SelectionResult{
				OddsAtPlacement:        *odds,
				ProbabilityAtPlacement: derefString(prob),
				Result:                 derefString(result),
				VoidFactor:             derefString(vf),
			})
		}
	}
	if err := rows.Err(); err != nil {
		return TicketForSettle{}, nil, false, fmt.Errorf("iterate ticket+selections: %w", err)
	}
	if !seen {
		// FOR UPDATE SKIP LOCKED miss OR ticket not found. Both surface
		// as "empty result" to the caller, identical to the historical
		// LoadTicketForSettle behaviour where pgx.ErrNoRows mapped to
		// (zero, false, nil).
		return TicketForSettle{}, nil, false, nil
	}
	return t, sels, true, nil
}

// UnresolvedCountIn returns how many selections in `sels` are still
// awaiting a result. Mirrors the SQL `WHERE result IS NULL` predicate
// used by UnresolvedCount, but operates on the in-memory slice
// LoadTicketWithSelections already returned so no extra round-trip is
// needed.
func UnresolvedCountIn(sels []SelectionResult) int {
	n := 0
	for _, s := range sels {
		if s.Result == "" {
			n++
		}
	}
	return n
}

func derefString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// RiskZilla currency: bank bookkeeping is USDC-only. OZ demo currency
// has no operator risk so its tickets skip the bank update.
const riskzillaCurrency = "USDC"

// UpdateRiskzillaBankOnSettle moves the operator bankroll in response
// to a ticket reaching a terminal state. Mirrors the apply-once
// invariant in SettleTicket: idempotent on a `<ticketID>:N` ref_id
// suffix shared with wallet_ledger.
//
// Money flow (operator point of view):
//   - bet_loss   (payout == 0): bettor lost; +stake to bank.
//   - bet_payout (payout >  0): bettor won; bank pays (stake − payout).
//     net is negative; bank shrinks.
//   - bet_refund (payout == stake): voided; net 0; recorded for audit.
//
// open_liability_micro is decremented by the ticket's potential_payout
// regardless of outcome — the ticket is no longer creating exposure.
//
// NOTE: when payoutMicro > stake (the common winning case) the bank
// limit can DROP below zero on a single big win. The DB CHECK on
// bank_limit_micro >= 0 would reject that. To keep settlement
// crash-safe, we clamp the bank floor at 0 on payouts and surface a
// memo so admins can review (the operator literally went broke on
// this ticket).
func UpdateRiskzillaBankOnSettle(
	ctx context.Context,
	tx pgx.Tx,
	ticketID, currency string,
	stakeMicro, payoutMicro, potentialPayoutMicro int64,
	ledgerKind string, // 'bet_loss' | 'bet_payout' | 'bet_refund'
) error {
	if currency != riskzillaCurrency {
		return nil
	}
	// open_liability moves once per ticket terminal event regardless of
	// generation — re-settlement uses ReverseSettledTicket to undo, so
	// the +/− pairs balance over a settle/rollback/re-settle cycle.
	if potentialPayoutMicro > 0 {
		if _, err := tx.Exec(ctx, `
UPDATE riskzilla_bank_state
   SET open_liability_micro = GREATEST(0, open_liability_micro - $1::bigint),
       updated_at = NOW()
 WHERE id = 'default'`, potentialPayoutMicro); err != nil {
			return fmt.Errorf("riskzilla open_liability decrement: %w", err)
		}
	}

	net := stakeMicro - payoutMicro // positive when bank wins
	refID, err := nextRiskzillaBankRefID(ctx, tx, ticketID, ledgerKind)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO riskzilla_bank_ledger (delta_micro, type, ref_type, ref_id, memo)
VALUES ($1, $2::riskzilla_bank_ledger_type, 'ticket', $3, $4)
ON CONFLICT (type, ref_type, ref_id) WHERE ref_id IS NOT NULL DO NOTHING`,
		net, ledgerKind, refID, fmt.Sprintf("ticket=%s", ticketID)); err != nil {
		return fmt.Errorf("riskzilla bank_ledger insert: %w", err)
	}
	// Adjust bank_limit by the net delta. Floor at 0 — the operator can
	// be temporarily underwater on a big win but the column CHECK keeps
	// the value non-negative, so we materialise the truth as 0 and rely
	// on the ledger for the real running total.
	if _, err := tx.Exec(ctx, `
UPDATE riskzilla_bank_state
   SET bank_limit_micro = GREATEST(0, bank_limit_micro + $1::bigint),
       updated_at = NOW()
 WHERE id = 'default'`, net); err != nil {
		return fmt.Errorf("riskzilla bank_limit update: %w", err)
	}
	return nil
}

// UpdateRiskzillaBankOnReverse undoes a prior bank movement. Called from
// ReverseSettledTicket. We re-add the open_liability the ticket was
// previously consuming and emit a compensating ledger row keyed off the
// reversed payout's ref_id.
func UpdateRiskzillaBankOnReverse(
	ctx context.Context,
	tx pgx.Tx,
	ticketID, currency string,
	stakeMicro, priorPayoutMicro, potentialPayoutMicro int64,
) error {
	if currency != riskzillaCurrency {
		return nil
	}
	if potentialPayoutMicro > 0 {
		if _, err := tx.Exec(ctx, `
UPDATE riskzilla_bank_state
   SET open_liability_micro = open_liability_micro + $1::bigint,
       updated_at = NOW()
 WHERE id = 'default'`, potentialPayoutMicro); err != nil {
			return fmt.Errorf("riskzilla open_liability re-add: %w", err)
		}
	}
	priorNet := stakeMicro - priorPayoutMicro
	if priorNet == 0 {
		return nil
	}
	// `manual_adjust` ledger type is the only one that doesn't require
	// the unique partial index — but we still want a stable ref_id to
	// pair it with the original. Use ticketID + ":reverse" as the key.
	refID := fmt.Sprintf("%s:reverse", ticketID)
	if _, err := tx.Exec(ctx, `
INSERT INTO riskzilla_bank_ledger (delta_micro, type, ref_type, ref_id, memo)
VALUES ($1, 'manual_adjust', 'ticket', $2, 'reverse-settle')
ON CONFLICT (type, ref_type, ref_id) WHERE ref_id IS NOT NULL DO NOTHING`,
		-priorNet, refID); err != nil {
		return fmt.Errorf("riskzilla bank_ledger reverse: %w", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE riskzilla_bank_state
   SET bank_limit_micro = GREATEST(0, bank_limit_micro - $1::bigint),
       updated_at = NOW()
 WHERE id = 'default'`, priorNet); err != nil {
		return fmt.Errorf("riskzilla bank_limit reverse: %w", err)
	}
	return nil
}

// nextRiskzillaBankRefID returns the next ref_id for a riskzilla bank
// ledger row. Mirrors the wallet_ledger generation-suffix convention
// (services/settlement/internal/store/store.go nextPayoutRefID): the
// first row uses the bare ticketID; subsequent re-settlements use
// `<ticketID>:N` so the unique partial index doesn't drop them.
func nextRiskzillaBankRefID(ctx context.Context, tx pgx.Tx, ticketID, ledgerKind string) (string, error) {
	var count int
	err := tx.QueryRow(ctx, `
SELECT COUNT(*) FROM riskzilla_bank_ledger
 WHERE type = $1::riskzilla_bank_ledger_type
   AND ref_type = 'ticket'
   AND (ref_id = $2 OR ref_id LIKE $2 || ':%')`,
		ledgerKind, ticketID).Scan(&count)
	if err != nil {
		return "", fmt.Errorf("count riskzilla bank rows: %w", err)
	}
	if count == 0 {
		return ticketID, nil
	}
	return fmt.Sprintf("%s:%d", ticketID, count+1), nil
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

// WriteCommunityProjection upserts a community_tickets row for `ticketID`
// based on the current state of the source-of-truth `tickets` table. It
// is called from the settlement transaction immediately after
// SettleTicket / ReverseSettledTicket; passing the same `tx` keeps the
// projection consistent with the underlying state without an
// eventual-write worker.
//
// The function reads the current ticket row inside the tx (so it sees
// the just-applied UPDATE) and joins through ticket_selections →
// markets → matches → tournaments → categories to compute total_odds,
// num_legs, and sport_ids. Idempotent on `community_tickets.ticket_id
// UNIQUE`: an UPSERT that updates status / payout / settled_at / odds
// keeps the row in sync across re-settle generations and rollback flows.
//
// Failure must NOT unwind the surrounding settlement transaction —
// callers log+continue. The admin backfill endpoint
// (`POST /admin/community/backfill`) recovers any miss.
func WriteCommunityProjection(ctx context.Context, tx pgx.Tx, ticketID string) error {
	const q = `
WITH legs AS (
  SELECT
    t.id           AS ticket_id,
    t.user_id      AS user_id,
    t.currency     AS currency,
    t.status       AS status,
    t.bet_type     AS bet_type,
    t.stake_micro  AS stake_micro,
    COALESCE(t.actual_payout_micro, 0) AS payout_micro,
    t.settled_at   AS settled_at,
    COUNT(*)::int                                                AS num_legs,
    COALESCE(
      ARRAY_AGG(DISTINCT c.sport_id) FILTER (WHERE c.sport_id IS NOT NULL),
      '{}'::int[]
    )                                                            AS sport_ids,
    -- Combine leg odds the same way placement does: simple product
    -- across selections. Truncated to NUMERIC(10,4) by the column cast.
    EXP(SUM(LN(ts2.odds_at_placement::float8)))::numeric(10, 4)  AS total_odds
    FROM tickets t
    JOIN ticket_selections ts2 ON ts2.ticket_id = t.id
    JOIN markets mk            ON mk.id = ts2.market_id
    JOIN matches mt            ON mt.id = mk.match_id
    JOIN tournaments tn        ON tn.id = mt.tournament_id
    JOIN categories c          ON c.id = tn.category_id
   WHERE t.id = $1
   GROUP BY t.id
)
INSERT INTO community_tickets (
  ticket_id, user_id, currency, status, bet_type,
  stake_micro, payout_micro, total_odds, num_legs, sport_ids, settled_at, score
)
SELECT
  l.ticket_id, l.user_id, l.currency, l.status, l.bet_type,
  l.stake_micro, l.payout_micro, l.total_odds, l.num_legs, l.sport_ids,
  COALESCE(l.settled_at, NOW()),
  -- Phase 10.3 deterministic score, frozen at settlement time.
  -- Mirrors services/api/src/modules/community/projection.ts. See
  -- docs/COMMUNITY_PLAN.md for component weights. Recency (30 pts) is
  -- applied at query time so the stored value stays time-invariant.
  COALESCE((
    SELECT
      (CASE WHEN l.payout_micro > l.stake_micro THEN
              25 * LEAST(1.0, LN(l.payout_micro::float8 / l.stake_micro::float8) / LN(10))
            ELSE 0
       END)
    + 15 * LEAST(1.0, LN(GREATEST(l.total_odds::float8, 1.0001)) / LN(20))
    + 15 * COALESCE(
        (SELECT (COUNT(*) FILTER (WHERE prior.payout_micro > prior.stake_micro))::float8
              / NULLIF(COUNT(*), 0)
           FROM community_tickets prior
          WHERE prior.user_id  = l.user_id
            AND prior.currency = l.currency
            AND prior.settled_at < COALESCE(l.settled_at, NOW())
            AND prior.status::text IN ('settled', 'cashed_out')),
        0
      )
  ), 0)
  FROM legs l
ON CONFLICT (ticket_id) DO UPDATE
   SET status       = EXCLUDED.status,
       payout_micro = EXCLUDED.payout_micro,
       settled_at   = EXCLUDED.settled_at,
       score        = EXCLUDED.score
`
	// Single-ticket upsert. Failure is non-fatal at the call site —
	// callers wrap this and log+continue so a projection bug never
	// unwinds a real settlement transaction.
	if _, err := tx.Exec(ctx, q, ticketID); err != nil {
		return fmt.Errorf("write community projection: %w", err)
	}
	return nil
}

// EvaluateAchievements scans `user_id`'s `community_tickets` aggregates
// (after the projection write has landed for `ticketID`) and inserts
// any newly-earned badge unlock rows. Idempotent on
// `(user_id, achievement_id)` composite PK — running this on every
// settlement, including replays and re-settle generations, can never
// produce a duplicate unlock.
//
// Predicates are currency-agnostic by design (Phase 10.4 starter set);
// see migration 0029_community_achievements.sql for the catalog. The
// SQL mirrors services/api/src/modules/community/achievements.ts on
// the TS side; both write the same rows so any of the four projection
// paths (settle, rollback, cashout, admin backfill) can drive unlocks
// without divergence.
//
// Failure semantics match WriteCommunityProjection — log + continue
// at the call site; never unwind a real settlement.
func EvaluateAchievements(ctx context.Context, tx pgx.Tx, ticketID string) error {
	const q = `
WITH target AS (
  SELECT user_id FROM community_tickets WHERE ticket_id = $1
),
stats AS (
  SELECT
    c.user_id,
    COUNT(*) FILTER (
      WHERE c.payout_micro > c.stake_micro
        AND c.status::text IN ('settled', 'cashed_out')
    )::int                                                       AS wins,
    MAX(c.num_legs) FILTER (
      WHERE c.payout_micro > c.stake_micro
        AND c.status::text IN ('settled', 'cashed_out')
    )                                                            AS max_legs_won,
    MAX(c.total_odds) FILTER (
      WHERE c.payout_micro > c.stake_micro
        AND c.status::text IN ('settled', 'cashed_out')
    )                                                            AS max_odds_won,
    MAX(c.payout_micro::float8 / NULLIF(c.stake_micro, 0)::float8) FILTER (
      WHERE c.payout_micro > c.stake_micro
        AND c.status::text IN ('settled', 'cashed_out')
    )                                                            AS max_payout_ratio
    FROM community_tickets c
    JOIN target t ON t.user_id = c.user_id
   GROUP BY c.user_id
)
INSERT INTO user_achievements (user_id, achievement_id)
SELECT user_id, ach FROM (
  SELECT user_id, 'first_win'   AS ach FROM stats WHERE wins             >= 1
  UNION ALL
  SELECT user_id, 'combo_5'           FROM stats WHERE max_legs_won      >= 5
  UNION ALL
  SELECT user_id, 'odds_20'           FROM stats WHERE max_odds_won      >= 20
  UNION ALL
  SELECT user_id, 'payout_100x'       FROM stats WHERE max_payout_ratio  >= 100
  UNION ALL
  SELECT user_id, 'streak_10'         FROM stats WHERE wins              >= 10
) candidates
ON CONFLICT (user_id, achievement_id) DO NOTHING
`
	if _, err := tx.Exec(ctx, q, ticketID); err != nil {
		return fmt.Errorf("evaluate achievements: %w", err)
	}
	return nil
}

// nextPayoutRefID returns the ref_id to use for a new ledger row of
// `ledgerType`. The first generation is the bare ticket UUID; subsequent
// generations append ":N" so a re-settle after rollback gets its own row.
//
// Concurrency: two transactions that both settle the same ticket (e.g.
// a re-settle racing a rollback's adjustment write) would otherwise
// both read count=N and try to insert <ticketID>:N+1 — the unique
// index rejects one, but the surrounding INSERT...ON CONFLICT DO
// NOTHING silently drops the duplicate ledger row even though its
// wallet UPDATE already ran. Take a per-ticket transaction-scoped
// advisory lock so the COUNT + INSERT happen atomically with respect
// to other transactions touching the same ticket.
func nextPayoutRefID(ctx context.Context, tx pgx.Tx, ticketID, ledgerType string) (string, error) {
	// hashtext(ticketID) projects the UUID into a 32-bit integer; we
	// use the single-arg pg_advisory_xact_lock variant which takes a
	// bigint. Same approach the catalog auto-mapper uses for its
	// per-URN serialisation. Lock auto-releases on tx end.
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
		ticketID,
	); err != nil {
		return "", fmt.Errorf("next payout ref id (lock): %w", err)
	}
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
// `bet_payout` OR `bet_refund` ledger row for `ticketID` that has NOT
// been compensated by an `adjustment` row sharing the same ref_id.
// Returns ("", false, nil) when no such row exists (either no settle
// ever happened or every settle has already been reversed).
//
// `bet_refund` is included so all-void combos (where the prior credit
// was a refund of the stake, not a payout) get a paired adjustment row
// when rolled back. Without it the audit invariant "every reversed
// credit has a matching adjustment" silently breaks for the all-void
// case. No money moves either way (refund == stake), but downstream
// reconciliation tools that expect every unreversed ledger row to map
// 1:1 with current ticket state would otherwise miscount.
func LatestUnreversedPayoutRefID(ctx context.Context, tx pgx.Tx, ticketID string) (string, bool, error) {
	var refID string
	err := tx.QueryRow(ctx, `
SELECT ref_id FROM wallet_ledger p
 WHERE p.ref_type = 'ticket'
   AND p.type IN ('bet_payout', 'bet_refund')
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

