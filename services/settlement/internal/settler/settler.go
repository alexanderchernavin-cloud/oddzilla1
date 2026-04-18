// Settler dispatches incoming Oddin XML into per-message handlers.
//
// Invariants (from docs/ARCHITECTURE.md#settlement and CLAUDE.md):
//   • Apply-once keyed on (event_urn, market_id, specifiers_hash, type,
//     payload_hash) via UNIQUE INSERT.
//   • Every wallet credit goes through a wallet_ledger row keyed on
//     (type, ref_type, ref_id) so replay is a no-op at two levels
//     (settlements insert + ledger unique partial index).
//   • Settlement messages not addressed to markets we know are logged
//     and acked — that's Oddin reaching us before feed-ingester does.
//     The next live settlement will catch it up.

package settler

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"sync/atomic"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"

	"github.com/oddzilla/settlement/internal/oddinxml"
	"github.com/oddzilla/settlement/internal/store"
)

const userChannelPrefix = "user:"

type Settler struct {
	store             *store.Store
	rdb               *redis.Client
	log               zerolog.Logger
	rollbackBatchSize int

	settled   int64
	cancelled int64
	rolledBack int64
	skipped   int64
	errors    int64
}

func New(st *store.Store, rdb *redis.Client, rollbackBatch int, log zerolog.Logger) *Settler {
	return &Settler{
		store:             st,
		rdb:               rdb,
		log:               log.With().Str("component", "settler").Logger(),
		rollbackBatchSize: rollbackBatch,
	}
}

func (s *Settler) Stats() (settled, cancelled, rolledBack, skipped, errs int64) {
	return atomic.LoadInt64(&s.settled),
		atomic.LoadInt64(&s.cancelled),
		atomic.LoadInt64(&s.rolledBack),
		atomic.LoadInt64(&s.skipped),
		atomic.LoadInt64(&s.errors)
}

// Handle is the AMQP-consumer entry point. `body` is the raw XML.
// Returns nil on success (or intentional skip). Returns error only for
// transient DB/Redis problems so AMQP nack+requeue is a retry.
func (s *Settler) Handle(ctx context.Context, routingKey string, body []byte) error {
	kind, err := oddinxml.PeekKind(body)
	if err != nil {
		s.log.Warn().Err(err).Str("rk", routingKey).Msg("unparseable; dropping")
		return nil
	}
	switch kind {
	case oddinxml.KindBetSettlement:
		return s.handleBetSettlement(ctx, body)
	case oddinxml.KindBetCancel:
		return s.handleBetCancel(ctx, body)
	case oddinxml.KindRollbackBetSettlement:
		return s.handleRollbackSettlement(ctx, body)
	case oddinxml.KindRollbackBetCancel:
		return s.handleRollbackCancel(ctx, body)
	case oddinxml.KindOddsChange,
		oddinxml.KindFixtureChange,
		oddinxml.KindBetStop,
		oddinxml.KindAlive,
		oddinxml.KindSnapshotComplete:
		// feed-ingester's domain; we ack and move on.
		return nil
	default:
		s.log.Warn().Str("rk", routingKey).Msg("unknown message kind; dropping")
		return nil
	}
}

// ─── bet_settlement ────────────────────────────────────────────────────────

func (s *Settler) handleBetSettlement(ctx context.Context, body []byte) error {
	var msg oddinxml.BetSettlement
	if err := unmarshal(body, &msg); err != nil {
		s.log.Warn().Err(err).Msg("bet_settlement: unmarshal failed; dropping")
		return nil
	}
	if msg.Outcomes == nil || len(msg.Outcomes.Markets) == 0 {
		return nil
	}

	for _, market := range msg.Outcomes.Markets {
		if err := s.applyMarketSettle(ctx, msg.EventID, msg.Timestamp, body, market); err != nil {
			atomic.AddInt64(&s.errors, 1)
			s.log.Warn().Err(err).
				Str("event", msg.EventID).
				Int("market", market.ID).
				Msg("apply market settle failed")
			// Don't return — other markets in the same message may still
			// succeed, and we don't want to requeue a partial failure.
		}
	}
	return nil
}

func (s *Settler) applyMarketSettle(ctx context.Context, eventURN string, ts int64, rawBody []byte, market oddinxml.Market) error {
	specs := oddinxml.Parse(market.Specifiers)
	specsHash := oddinxml.Hash(specs)

	payloadHash := hashMarketPayload("settle", eventURN, market, rawBody)
	payloadJSON, _ := json.Marshal(marketAuditPayload(eventURN, ts, market))

	tx, err := s.store.BeginTx(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	marketID, ok, err := store.FindMarket(ctx, tx, eventURN, market.ID, specsHash)
	if err != nil {
		return err
	}
	if !ok {
		// Oddin settled a market we don't have yet — happens when a
		// settlement beats the ingester on a fresh fixture. Drop
		// silently; the market will resolve when it arrives.
		atomic.AddInt64(&s.skipped, 1)
		s.log.Debug().Str("event", eventURN).Int("market", market.ID).Msg("market unknown; skipping")
		return nil
	}

	_, inserted, err := store.InsertIfNew(ctx, tx, store.SettlementInsert{
		EventURN:       eventURN,
		MarketID:       marketID,
		SpecifiersHash: specsHash,
		Type:           "settle",
		PayloadHash:    payloadHash,
		PayloadJSON:    payloadJSON,
	})
	if err != nil {
		return err
	}
	if !inserted {
		atomic.AddInt64(&s.skipped, 1)
		return tx.Commit(ctx) // replay — nothing to do
	}

	// Flip market status to settled (-3) so no further bets are accepted.
	if err := store.SetMarketStatus(ctx, tx, marketID, -3, ts); err != nil {
		return err
	}

	// Apply outcome results + cascade into ticket_selections.
	for _, o := range market.Outcomes {
		result := mapOutcomeResult(o.Result, o.VoidFactor)
		if err := store.UpdateOutcomeResult(ctx, tx, marketID, o.ID, result, o.VoidFactor, ts); err != nil {
			return err
		}
		if err := store.ApplyOutcomeToSelections(ctx, tx, marketID, o.ID, result, o.VoidFactor); err != nil {
			return err
		}
	}

	// Any affected ticket whose selections are all resolved gets settled.
	tickets, err := store.AffectedTicketsForMarket(ctx, tx, marketID)
	if err != nil {
		return err
	}

	settledTickets := make([]string, 0, len(tickets))
	for _, tid := range tickets {
		didSettle, err := s.maybeSettleTicket(ctx, tx, tid, "bet_settlement")
		if err != nil {
			return err
		}
		if didSettle {
			settledTickets = append(settledTickets, tid)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit settle: %w", err)
	}

	atomic.AddInt64(&s.settled, int64(len(settledTickets)))
	for _, tid := range settledTickets {
		s.publishTicketEvent(ctx, tid, "settled", "")
	}
	return nil
}

// maybeSettleTicket returns (true, nil) if the ticket transitioned to
// settled in this tx. Returns (false, nil) if it's locked by another
// worker (SKIP LOCKED miss), already settled, or has unresolved
// selections remaining.
func (s *Settler) maybeSettleTicket(ctx context.Context, tx pgx.Tx, ticketID, sourceTag string) (bool, error) {
	t, locked, err := store.LoadTicketForSettle(ctx, tx, ticketID)
	if err != nil {
		return false, err
	}
	if !locked {
		return false, nil
	}
	if t.Status != "accepted" {
		// Either still pending_delay (shouldn't happen — bet-delay moves
		// it first) or already settled/voided/rejected.
		return false, nil
	}
	unresolved, err := store.UnresolvedCount(ctx, tx, ticketID)
	if err != nil {
		return false, err
	}
	if unresolved > 0 {
		return false, nil
	}

	selections, err := store.ResolvedSelections(ctx, tx, ticketID)
	if err != nil {
		return false, err
	}

	payout, ledgerType, err := computePayout(t.BetType, t.StakeMicro, selections)
	if err != nil {
		return false, err
	}

	if err := store.SettleTicket(ctx, tx, t, payout, ledgerType, sourceTag); err != nil {
		return false, err
	}
	return true, nil
}

// ─── bet_cancel ────────────────────────────────────────────────────────────

func (s *Settler) handleBetCancel(ctx context.Context, body []byte) error {
	var msg oddinxml.BetCancel
	if err := unmarshal(body, &msg); err != nil {
		s.log.Warn().Err(err).Msg("bet_cancel: unmarshal failed; dropping")
		return nil
	}
	for _, market := range msg.Markets {
		if err := s.applyMarketCancel(ctx, msg.EventID, msg.Timestamp, body, market); err != nil {
			atomic.AddInt64(&s.errors, 1)
			s.log.Warn().Err(err).
				Str("event", msg.EventID).
				Int("market", market.ID).
				Msg("apply cancel failed")
		}
	}
	return nil
}

func (s *Settler) applyMarketCancel(ctx context.Context, eventURN string, ts int64, rawBody []byte, market oddinxml.Market) error {
	specs := oddinxml.Parse(market.Specifiers)
	specsHash := oddinxml.Hash(specs)

	payloadHash := hashMarketPayload("cancel", eventURN, market, rawBody)
	payloadJSON, _ := json.Marshal(marketAuditPayload(eventURN, ts, market))

	tx, err := s.store.BeginTx(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	marketID, ok, err := store.FindMarket(ctx, tx, eventURN, market.ID, specsHash)
	if err != nil {
		return err
	}
	if !ok {
		atomic.AddInt64(&s.skipped, 1)
		return nil
	}

	_, inserted, err := store.InsertIfNew(ctx, tx, store.SettlementInsert{
		EventURN:       eventURN,
		MarketID:       marketID,
		SpecifiersHash: specsHash,
		Type:           "cancel",
		PayloadHash:    payloadHash,
		PayloadJSON:    payloadJSON,
	})
	if err != nil {
		return err
	}
	if !inserted {
		atomic.AddInt64(&s.skipped, 1)
		return tx.Commit(ctx)
	}

	if err := store.SetMarketStatus(ctx, tx, marketID, -4, ts); err != nil {
		return err
	}

	tickets, err := store.AffectedTicketsForMarket(ctx, tx, marketID)
	if err != nil {
		return err
	}

	// Cancel-after-settle support. Per the Oddin docs:
	//
	//   "If a market is cancelled after it has already been settled,
	//    there won't be any rollback_bet_settlement messages to reverse
	//    the settlement; the market will just receive the bet_cancel
	//    message directly. The bet voiding process should be implemented
	//    in the same way as if the settled market had previously been
	//    rollbacked."
	//
	// Walk every affected ticket; if any are currently 'settled', undo
	// that settlement (wallet + ledger compensating row) so the cancel
	// path below can re-resolve the selections as void and refund the
	// stake exactly as it would for a never-settled ticket.
	reversedSettled := 0
	for _, tid := range tickets {
		ok, err := s.reverseSettledForCancel(ctx, tx, tid)
		if err != nil {
			return err
		}
		if ok {
			reversedSettled++
		}
	}

	// Clear any pre-existing selection results for THIS market across
	// every ticket (settled-then-reversed tickets had results we just
	// undid; tickets that were already 'accepted' had NULL results
	// already). VoidSelectionsForMarket then marks every NULL selection
	// on the market as void, so the next settle pass refunds stakes.
	if reversedSettled > 0 {
		if err := store.ReverseSelectionsForMarket(ctx, tx, marketID); err != nil {
			return err
		}
	}
	if err := store.VoidSelectionsForMarket(ctx, tx, marketID, market.StartTime, market.EndTime); err != nil {
		return err
	}

	settledTickets := make([]string, 0, len(tickets))
	for _, tid := range tickets {
		didSettle, err := s.maybeSettleTicket(ctx, tx, tid, "bet_cancel")
		if err != nil {
			return err
		}
		if didSettle {
			settledTickets = append(settledTickets, tid)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit cancel: %w", err)
	}

	atomic.AddInt64(&s.cancelled, int64(len(settledTickets)))
	for _, tid := range settledTickets {
		s.publishTicketEvent(ctx, tid, "settled", "market_cancelled")
	}
	return nil
}

// reverseSettledForCancel undoes a prior settlement on a ticket so the
// cancel handler can re-resolve it as void. Returns true when the ticket
// was reversed (was previously 'settled'); false when the ticket is in
// any other state. SKIP-LOCKED misses also return false (another worker
// holds it; their settle will pick up the cancel on its next pass).
func (s *Settler) reverseSettledForCancel(ctx context.Context, tx pgx.Tx, ticketID string) (bool, error) {
	t, locked, err := store.LoadTicketForSettle(ctx, tx, ticketID)
	if err != nil {
		return false, err
	}
	if !locked || t.Status != "settled" {
		return false, nil
	}
	var prior int64
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(actual_payout_micro, 0) FROM tickets WHERE id = $1`, ticketID,
	).Scan(&prior); err != nil {
		return false, fmt.Errorf("read actual_payout for cancel-reverse: %w", err)
	}
	if err := store.ReverseSettledTicket(ctx, tx, ticketID, t.UserID, "bet_cancel", t.StakeMicro, prior); err != nil {
		return false, err
	}
	return true, nil
}

// ─── rollback_bet_settlement ───────────────────────────────────────────────

func (s *Settler) handleRollbackSettlement(ctx context.Context, body []byte) error {
	var msg oddinxml.RollbackBetSettlement
	if err := unmarshal(body, &msg); err != nil {
		s.log.Warn().Err(err).Msg("rollback_bet_settlement: unmarshal failed; dropping")
		return nil
	}

	for _, market := range msg.Markets {
		if err := s.applyMarketRollbackSettle(ctx, msg.EventID, msg.Timestamp, body, market); err != nil {
			atomic.AddInt64(&s.errors, 1)
			s.log.Warn().Err(err).
				Str("event", msg.EventID).
				Int("market", market.ID).
				Msg("apply rollback_settle failed")
		}
	}
	return nil
}

func (s *Settler) applyMarketRollbackSettle(ctx context.Context, eventURN string, ts int64, rawBody []byte, market oddinxml.Market) error {
	specs := oddinxml.Parse(market.Specifiers)
	specsHash := oddinxml.Hash(specs)
	payloadHash := hashMarketPayload("rollback_settle", eventURN, market, rawBody)
	payloadJSON, _ := json.Marshal(marketAuditPayload(eventURN, ts, market))

	tickets, err := s.applyRollback(ctx, eventURN, ts, market, specsHash, "rollback_settle", payloadHash, payloadJSON)
	if err != nil {
		return err
	}

	atomic.AddInt64(&s.rolledBack, int64(len(tickets)))
	for _, tid := range tickets {
		s.publishTicketEvent(ctx, tid, "accepted", "rollback_settlement")
	}
	return nil
}

// ─── rollback_bet_cancel ───────────────────────────────────────────────────

func (s *Settler) handleRollbackCancel(ctx context.Context, body []byte) error {
	var msg oddinxml.RollbackBetCancel
	if err := unmarshal(body, &msg); err != nil {
		s.log.Warn().Err(err).Msg("rollback_bet_cancel: unmarshal failed; dropping")
		return nil
	}

	for _, market := range msg.Markets {
		if err := s.applyMarketRollbackCancel(ctx, msg.EventID, msg.Timestamp, body, market); err != nil {
			atomic.AddInt64(&s.errors, 1)
			s.log.Warn().Err(err).
				Str("event", msg.EventID).
				Int("market", market.ID).
				Msg("apply rollback_cancel failed")
		}
	}
	return nil
}

func (s *Settler) applyMarketRollbackCancel(ctx context.Context, eventURN string, ts int64, rawBody []byte, market oddinxml.Market) error {
	specs := oddinxml.Parse(market.Specifiers)
	specsHash := oddinxml.Hash(specs)
	payloadHash := hashMarketPayload("rollback_cancel", eventURN, market, rawBody)
	payloadJSON, _ := json.Marshal(marketAuditPayload(eventURN, ts, market))

	tickets, err := s.applyRollback(ctx, eventURN, ts, market, specsHash, "rollback_cancel", payloadHash, payloadJSON)
	if err != nil {
		return err
	}

	atomic.AddInt64(&s.rolledBack, int64(len(tickets)))
	for _, tid := range tickets {
		s.publishTicketEvent(ctx, tid, "accepted", "rollback_cancel")
	}
	return nil
}

// applyRollback is the common body for both rollback types. It:
//   - Inserts the apply-once settlements row (dedupes replays)
//   - Walks affected tickets in chunks of rollbackBatchSize (bounds lock
//     contention when Oddin cascades across large fixtures)
//   - Reverses each settled ticket's wallet + ledger; clears selection
//     results so future settle messages can re-apply
//   - Restores market.status to 1 (active) — Oddin will reissue the
//     correct settlement/cancel afterwards
//   - Logs an admin_audit row summarizing the action
func (s *Settler) applyRollback(ctx context.Context, eventURN string, ts int64, market oddinxml.Market, specsHash []byte, rollbackType string, payloadHash, payloadJSON []byte) ([]string, error) {
	tx, err := s.store.BeginTx(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	marketID, ok, err := store.FindMarket(ctx, tx, eventURN, market.ID, specsHash)
	if err != nil {
		return nil, err
	}
	if !ok {
		atomic.AddInt64(&s.skipped, 1)
		return nil, nil
	}

	_, inserted, err := store.InsertIfNew(ctx, tx, store.SettlementInsert{
		EventURN:       eventURN,
		MarketID:       marketID,
		SpecifiersHash: specsHash,
		Type:           rollbackType,
		PayloadHash:    payloadHash,
		PayloadJSON:    payloadJSON,
	})
	if err != nil {
		return nil, err
	}
	if !inserted {
		atomic.AddInt64(&s.skipped, 1)
		return nil, tx.Commit(ctx)
	}

	// Reverse selection results for this market (re-opens them).
	if err := store.ReverseSelectionsForMarket(ctx, tx, marketID); err != nil {
		return nil, err
	}
	// Restore market to active so new settle messages can re-apply.
	if err := store.SetMarketStatus(ctx, tx, marketID, 1, ts); err != nil {
		return nil, err
	}

	tickets, err := store.AffectedTicketsForMarket(ctx, tx, marketID)
	if err != nil {
		return nil, err
	}

	reversed := make([]string, 0, len(tickets))
	// Chunk to keep lock-set bounded. Within a chunk we already hold one
	// transaction; Oddin cascades rarely hit 100+ per market for esports,
	// so one-tx-per-chunk is fine.
	for i := 0; i < len(tickets); i += s.rollbackBatchSize {
		end := i + s.rollbackBatchSize
		if end > len(tickets) {
			end = len(tickets)
		}
		for _, tid := range tickets[i:end] {
			ok, err := s.reverseTicket(ctx, tx, tid, rollbackType)
			if err != nil {
				return nil, err
			}
			if ok {
				reversed = append(reversed, tid)
			}
		}
	}

	// Audit trail.
	if err := store.InsertAdminAudit(ctx, tx, "settlement."+rollbackType,
		"market", fmt.Sprintf("%d", marketID),
		nil, payloadJSON); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit %s: %w", rollbackType, err)
	}
	return reversed, nil
}

func (s *Settler) reverseTicket(ctx context.Context, tx pgx.Tx, ticketID, reason string) (bool, error) {
	t, locked, err := store.LoadTicketForSettle(ctx, tx, ticketID)
	if err != nil {
		return false, err
	}
	if !locked {
		return false, nil
	}
	if t.Status != "settled" {
		return false, nil
	}

	// Need the prior payout to reverse it. We stored actual_payout_micro
	// on the ticket — re-read it.
	var prior int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(actual_payout_micro, 0) FROM tickets WHERE id = $1`, ticketID).Scan(&prior); err != nil {
		return false, fmt.Errorf("read actual_payout: %w", err)
	}

	if err := store.ReverseSettledTicket(ctx, tx, ticketID, t.UserID, reason, t.StakeMicro, prior); err != nil {
		return false, err
	}
	return true, nil
}

// ─── Helpers ───────────────────────────────────────────────────────────────

func (s *Settler) publishTicketEvent(ctx context.Context, ticketID, status, reason string) {
	payload := map[string]any{
		"type":     "ticket",
		"ticketId": ticketID,
		"status":   status,
	}
	if reason != "" {
		payload["rejectReason"] = reason
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}

	// Fetch user_id once so we can address the pub/sub channel. Cheap
	// lookup; skipping errors is fine (worst case: frame not delivered).
	var userID string
	if err := s.store.Pool().QueryRow(ctx, `SELECT user_id FROM tickets WHERE id = $1`, ticketID).Scan(&userID); err != nil {
		return
	}
	if err := s.rdb.Publish(ctx, userChannelPrefix+userID, body).Err(); err != nil {
		s.log.Debug().Err(err).Msg("publish ticket event failed")
	}
}

func hashMarketPayload(settlementType, eventURN string, market oddinxml.Market, raw []byte) []byte {
	// Hash a canonical representation so retries of the same data (but
	// re-serialized XML) map to the same key.
	h := sha256.New()
	fmt.Fprintf(h, "%s|%s|%d|%s", settlementType, eventURN, market.ID, market.Specifiers)
	for _, o := range market.Outcomes {
		fmt.Fprintf(h, "|%s=%s,%s", o.ID, o.Result, o.VoidFactor)
	}
	// Mix in a hash of the raw body too — catches changes we didn't
	// anticipate (new attributes) so we err on the side of "new event".
	h.Write(raw)
	return h.Sum(nil)
}

func marketAuditPayload(eventURN string, ts int64, market oddinxml.Market) map[string]any {
	outs := make([]map[string]any, 0, len(market.Outcomes))
	for _, o := range market.Outcomes {
		outs = append(outs, map[string]any{
			"outcome_id":  o.ID,
			"result":      o.Result,
			"void_factor": o.VoidFactor,
		})
	}
	return map[string]any{
		"event_urn":         eventURN,
		"timestamp":         ts,
		"provider_market":  market.ID,
		"specifiers":       market.Specifiers,
		"status":           market.Status,
		"void_reason":      market.VoidReasonID,
		"void_reason_params": market.VoidReasonParams,
		"outcomes":         outs,
	}
}

// mapOutcomeResult converts Oddin (result, void_factor) → our
// outcome_result enum string. Returns "" if neither matches (caller
// treats as void).
func mapOutcomeResult(result, voidFactor string) string {
	// Pure void (refund all) takes priority over result value.
	if voidFactor == "1" || voidFactor == "1.0" || voidFactor == "1.00" {
		return "void"
	}
	switch result {
	case "1":
		if isHalf(voidFactor) {
			return "half_won"
		}
		return "won"
	case "0":
		if isHalf(voidFactor) {
			return "half_lost"
		}
		return "lost"
	}
	return "void"
}

func isHalf(vf string) bool {
	switch vf {
	case "0.5", ".5", "0.50":
		return true
	}
	return false
}

func unmarshal(body []byte, v any) error {
	if err := xml.Unmarshal(body, v); err != nil {
		return fmt.Errorf("xml unmarshal: %w", err)
	}
	return nil
}

// computePayout returns (payoutMicro, ledgerType, err) for a ticket.
// Singles only for MVP — asserts len(selections) == 1.
func computePayout(betType string, stakeMicro int64, selections []store.SelectionResult) (int64, string, error) {
	if betType != "single" {
		return 0, "", fmt.Errorf("bet_type %q not supported yet", betType)
	}
	if len(selections) != 1 {
		return 0, "", fmt.Errorf("single expected exactly 1 selection, got %d", len(selections))
	}
	sel := selections[0]
	payout, err := SinglePayout(stakeMicro, sel.OddsAtPlacement, sel.Result, sel.VoidFactor)
	if err != nil {
		return 0, "", err
	}
	return payout, LedgerTypeFor(sel.Result), nil
}
