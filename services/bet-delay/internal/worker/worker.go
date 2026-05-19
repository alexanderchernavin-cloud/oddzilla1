// bet-delay worker. LISTENs on Postgres channel 'bet_delay' AND sweeps
// the table every SweepInterval — belt + suspenders so a missed NOTIFY
// (reconnect window, crash) doesn't strand tickets.
//
// For each ticket whose not_before_ts has elapsed:
//   * Start a transaction; SELECT FOR UPDATE SKIP LOCKED the ticket row
//   * Re-read current published_odds + market.status + outcome.active
//   * Reject if: any market is not status=1, any outcome is inactive,
//     any outcome has no current price, or odds drift > tolerance from
//     placement odds.
//   * Else promote to 'accepted'.
//   * Commit; publish a {type:"ticket", status:...} frame to
//     `user:{userId}` pub/sub channel so the client sees the result.

package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"

	"github.com/oddzilla/bet-delay/internal/store"
)

const userChannelPrefix = "user:"

type Worker struct {
	pool            *pgxpool.Pool
	rdb             *redis.Client
	st              *store.Store
	log             zerolog.Logger
	sweepInterval   time.Duration
	driftTolerance  float64
	batchSize       int

	promoted int64
	rejected int64
	errors   int64

	// Healthcheck signals. listenConnected flips false during the 2s
	// reconnect window after a LISTEN error; the sweep loop is the
	// fallback path so a brief disconnect doesn't strand tickets, but
	// a sustained-false signal is the operator's "the LISTEN side is
	// broken" tripwire. lastNotifyTsUnix is the Unix-timestamp of the
	// most recent NOTIFY we processed (zero = none yet).
	listenConnected  uint32
	lastNotifyTsUnix int64
}

// Health is the snapshot the /healthz handler renders. Read-only.
type Health struct {
	ListenConnected bool   `json:"listenConnected"`
	LastNotifyAt    string `json:"lastNotifyAt,omitempty"`
}

func New(pool *pgxpool.Pool, rdb *redis.Client, st *store.Store, driftBp, batchSize int, sweep time.Duration, log zerolog.Logger) *Worker {
	return &Worker{
		pool:           pool,
		rdb:            rdb,
		st:             st,
		log:            log.With().Str("component", "worker").Logger(),
		sweepInterval:  sweep,
		driftTolerance: float64(driftBp) / 10000.0,
		batchSize:      batchSize,
	}
}

// Run blocks until ctx is cancelled. It launches two loops: a LISTEN
// loop and a periodic sweep. Both feed the same processBatch function.
func (w *Worker) Run(ctx context.Context) error {
	go w.listen(ctx)
	go w.sweepLoop(ctx)
	<-ctx.Done()
	return ctx.Err()
}

func (w *Worker) Stats() (promoted, rejected, errs int64) {
	return atomic.LoadInt64(&w.promoted),
		atomic.LoadInt64(&w.rejected),
		atomic.LoadInt64(&w.errors)
}

// Health returns the LISTEN-side liveness snapshot for /healthz. The
// underlying counters are updated atomically by the listen loop.
func (w *Worker) Health() Health {
	h := Health{
		ListenConnected: atomic.LoadUint32(&w.listenConnected) == 1,
	}
	if ts := atomic.LoadInt64(&w.lastNotifyTsUnix); ts > 0 {
		h.LastNotifyAt = time.Unix(ts, 0).UTC().Format(time.RFC3339)
	}
	return h
}

// ─── LISTEN loop ───────────────────────────────────────────────────────────

func (w *Worker) listen(ctx context.Context) {
	for ctx.Err() == nil {
		if err := w.listenOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
			atomic.StoreUint32(&w.listenConnected, 0)
			w.log.Warn().Err(err).Msg("LISTEN loop errored; reconnecting in 2s")
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
		}
	}
}

func (w *Worker) listenOnce(ctx context.Context) error {
	// Acquire a dedicated connection so LISTEN survives across calls.
	conn, err := w.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, "LISTEN bet_delay"); err != nil {
		return fmt.Errorf("LISTEN: %w", err)
	}
	atomic.StoreUint32(&w.listenConnected, 1)
	defer atomic.StoreUint32(&w.listenConnected, 0)
	w.log.Info().Msg("listening on bet_delay channel")

	for ctx.Err() == nil {
		n, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return fmt.Errorf("wait notification: %w", err)
		}
		if n == nil {
			continue
		}
		atomic.StoreInt64(&w.lastNotifyTsUnix, time.Now().Unix())
		if err := w.processOne(ctx, n.Payload); err != nil {
			w.log.Warn().Err(err).Str("ticket", n.Payload).Msg("process from NOTIFY failed")
		}
	}
	return nil
}

// ─── Sweep loop ────────────────────────────────────────────────────────────

func (w *Worker) sweepLoop(ctx context.Context) {
	t := time.NewTicker(w.sweepInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		pending, err := w.st.ListReady(ctx, w.batchSize)
		if err != nil {
			atomic.AddInt64(&w.errors, 1)
			w.log.Warn().Err(err).Msg("list ready failed")
			continue
		}
		for _, p := range pending {
			if err := w.processTicket(ctx, p); err != nil {
				atomic.AddInt64(&w.errors, 1)
				w.log.Warn().Err(err).Str("ticket", p.ID).Msg("process failed")
			}
		}
	}
}

// ─── Core processing ───────────────────────────────────────────────────────

// processOne runs for NOTIFY-driven attempts where we only have the id;
// it must still re-read stake + currency + not_before_ts.
func (w *Worker) processOne(ctx context.Context, ticketID string) error {
	const q = `
SELECT id, user_id, currency, bet_type::text, stake_micro, potential_payout_micro,
       not_before_ts, accept_odds_changes, bet_meta
  FROM tickets
 WHERE id = $1 AND status = 'pending_delay'`
	var p store.PendingTicket
	err := w.pool.QueryRow(ctx, q, ticketID).Scan(
		&p.ID, &p.UserID, &p.Currency, &p.BetType, &p.StakeMicro,
		&p.PotentialPayoutMicro, &p.NotBeforeTs, &p.AcceptOddsChanges,
		&p.BetMetaJSON,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // already processed
		}
		return fmt.Errorf("fetch ticket: %w", err)
	}
	if !p.NotBeforeTs.IsZero() && time.Now().Before(p.NotBeforeTs) {
		// Too early; sweep loop will pick it up when the time comes.
		return nil
	}
	return w.processTicket(ctx, p)
}

func (w *Worker) processTicket(ctx context.Context, p store.PendingTicket) error {
	tx, err := w.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Lock — SKIP LOCKED means another replica took it; we simply move on.
	status, ok, err := store.Lock(ctx, tx, p.ID)
	if err != nil {
		return fmt.Errorf("lock: %w", err)
	}
	if !ok {
		return nil
	}
	if status != "pending_delay" {
		return nil // already resolved
	}

	selections, err := store.LoadSelections(ctx, tx, p.ID)
	if err != nil {
		return err
	}

	// Per-bettor odds adjustment cascade. Meaningless for tiple / tippot
	// (probability-anchored pricing) and betbuilder (OBB session combined
	// odds); for those products we skip the load and the resolver returns
	// the empty-cascade sentinel.
	var bettorAdj *store.BettorAdjustment
	if p.BetType == "single" || p.BetType == "combo" {
		bettorAdj, err = store.LoadBettorAdjustment(ctx, tx, p.UserID)
		if err != nil {
			return fmt.Errorf("load bettor adjustment: %w", err)
		}
	}

	decision := w.evaluate(p, selections, bettorAdj)
	switch decision.action {
	case actionReject:
		if err := store.RejectAndRefund(ctx, tx, p.ID, p.UserID, p.Currency, decision.reason, p.StakeMicro); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit reject: %w", err)
		}
		atomic.AddInt64(&w.rejected, 1)
		w.publishTicketEvent(ctx, p.UserID, p.ID, "rejected", &decision.reason)
		w.log.Info().Str("ticket", p.ID).Str("reason", decision.reason).Msg("ticket rejected")
		return nil

	case actionAccept:
		if err := store.Accept(ctx, tx, p.ID); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit accept: %w", err)
		}
		atomic.AddInt64(&w.promoted, 1)
		w.publishTicketEvent(ctx, p.UserID, p.ID, "accepted", nil)
		w.log.Info().Str("ticket", p.ID).Msg("ticket accepted")
		return nil

	case actionAcceptWithUpdatedOdds:
		if err := store.AcceptWithUpdatedOdds(
			ctx, tx, p.ID, p.PotentialPayoutMicro, decision.newPayoutMicro, decision.updatedLegs,
		); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit accept-updated: %w", err)
		}
		atomic.AddInt64(&w.promoted, 1)
		// Surfaces as a regular 'accepted' status in the WS frame — the
		// updated leg odds + recomputed potential_payout_micro are
		// visible in the next /bets fetch so the client picks them up
		// without a separate frame type. Log distinctly for ops.
		w.publishTicketEvent(ctx, p.UserID, p.ID, "accepted", nil)
		w.log.Info().
			Str("ticket", p.ID).
			Int64("oldPayoutMicro", p.PotentialPayoutMicro).
			Int64("newPayoutMicro", decision.newPayoutMicro).
			Int("legsRepriced", len(decision.updatedLegs)).
			Msg("ticket accepted at updated odds")
		return nil
	}
	return nil
}

type evalAction int

const (
	actionReject evalAction = iota
	actionAccept
	actionAcceptWithUpdatedOdds
)

type evalResult struct {
	action          evalAction
	reason          string
	newPayoutMicro  int64
	updatedLegs     []store.UpdatedLegOdds
}

// evaluate re-checks each leg of a pending ticket against the latest
// published_odds + market.status + outcome.active. It either rejects,
// accepts at the placement odds, or — when the bettor opted in via
// `accept_odds_changes=true` and the only failure is per-leg drift —
// signals an accept-with-updated-odds path so the worker rewrites the
// leg prices + potential payout before flipping the ticket to accepted.
//
// Suspended / inactive / no-current-price checks reject regardless of
// the flag; "accept any odds change" deliberately doesn't mean "accept
// against a market that's no longer bettable".
//
// BetType behaviour:
//   - "betbuilder": per-leg drift is intentionally not a meaningful gate
//     (Oddin's OBB engine prices the combined session non-multiplicatively).
//     Drift is skipped; status/activity still apply.
//   - "tiple" / "tippot": price is anchored to the per-leg probability
//     snapshot frozen on the ticket — re-multiplying current published
//     odds wouldn't yield a meaningful new payout, so accept_odds_changes
//     is ignored. Drift still gates rejection.
//   - "single" / "combo": drift rejects unless accept_odds_changes is
//     true, in which case we re-price.
func (w *Worker) evaluate(p store.PendingTicket, selections []store.Selection, bettorAdj *store.BettorAdjustment) evalResult {
	if len(selections) == 0 {
		return evalResult{action: actionReject, reason: "no_selections"}
	}
	skipDrift := p.BetType == "betbuilder"
	canReprice := p.AcceptOddsChanges && (p.BetType == "single" || p.BetType == "combo")

	type legCheck struct {
		marketID  int64
		outcomeID string
		current   float64
		currentS  string
		drifted   bool
	}
	checks := make([]legCheck, 0, len(selections))
	driftDetected := false

	for _, s := range selections {
		if s.MarketStatus != 1 {
			return evalResult{action: actionReject, reason: "market_suspended"}
		}
		if !s.OutcomeActive {
			return evalResult{action: actionReject, reason: "outcome_inactive"}
		}
		if s.CurrentPublished == nil || *s.CurrentPublished == "" {
			return evalResult{action: actionReject, reason: "no_current_price"}
		}
		placed, err1 := strconv.ParseFloat(s.OddsAtPlacement, 64)
		currentRaw, err2 := strconv.ParseFloat(*s.CurrentPublished, 64)
		if err1 != nil || err2 != nil || placed <= 0 || currentRaw <= 0 {
			return evalResult{action: actionReject, reason: "odds_parse"}
		}
		// The leg's frozen odds_at_placement is already the bettor's
		// *adjusted* price (placement applies the cascade on the way in).
		// To compare like-for-like we must adjust the current published
		// price the same way before measuring drift OR re-pricing on the
		// accept_odds_changes path. Mirror the TS applyBettorAdjustment
		// floor and fair-odds ceiling.
		current := currentRaw
		currentS := *s.CurrentPublished
		if !bettorAdj.Empty() {
			bp := bettorAdj.Resolve(s.MatchID, s.TournamentID, s.SportID)
			if bp != 0 {
				adj := applyBettorAdjustment(currentRaw, s.Probability, bp)
				current = adj
				currentS = formatOddsFloor2(adj)
			}
		}
		drifted := false
		if !skipDrift {
			drift := math.Abs(current-placed) / placed
			if drift > w.driftTolerance {
				drifted = true
				driftDetected = true
				if !canReprice {
					return evalResult{action: actionReject, reason: "odds_drift_exceeded"}
				}
			}
		}
		checks = append(checks, legCheck{
			marketID:  s.MarketID,
			outcomeID: s.OutcomeID,
			current:   current,
			currentS:  currentS,
			drifted:   drifted,
		})
	}

	if !driftDetected {
		return evalResult{action: actionAccept}
	}

	// Re-pricing path. Compute the new potential payout from the latest
	// per-leg published prices, preserving any frozen combi-boost
	// multiplier on bet_meta so re-priced combos respect the same
	// promotion the bettor saw at placement.
	productOdds := 1.0
	updates := make([]store.UpdatedLegOdds, 0, len(checks))
	for _, c := range checks {
		productOdds *= c.current
		if c.drifted {
			updates = append(updates, store.UpdatedLegOdds{
				MarketID:  c.marketID,
				OutcomeID: c.outcomeID,
				NewOdds:   c.currentS,
			})
		}
	}
	boost := extractBoostMultiplier(p.BetMetaJSON)
	if boost > 1.0 {
		productOdds *= boost
	}
	// floor(stakeMicro * decimalOdds). Match the API placement math
	// (packages/types money.multiplyMicroByOdds) — bigint multiply by
	// scaled decimal, floor-truncate. Cap at int64 to keep arithmetic
	// safe; absurdly-high products would have been rejected at the API.
	stake := big.NewInt(p.StakeMicro)
	scaled := big.NewFloat(productOdds * 1e8)
	scaledInt, _ := scaled.Int(nil)
	tmp := new(big.Int).Mul(stake, scaledInt)
	tmp.Div(tmp, big.NewInt(1e8))
	if !tmp.IsInt64() {
		// Shouldn't happen given the API gate; fail-closed to reject.
		return evalResult{action: actionReject, reason: "odds_drift_exceeded"}
	}
	newPayout := tmp.Int64()
	if newPayout <= 0 {
		return evalResult{action: actionReject, reason: "odds_drift_exceeded"}
	}
	return evalResult{
		action:         actionAcceptWithUpdatedOdds,
		newPayoutMicro: newPayout,
		updatedLegs:    updates,
	}
}

// extractBoostMultiplier pulls the combi-boost multiplier out of
// tickets.bet_meta when present. Returns 1.0 (no-op) on any parse failure
// or absent product/multiplier — the API frozen this value at placement
// so a malformed payload is a real bug; we just don't double-apply it.
func extractBoostMultiplier(raw []byte) float64 {
	if len(raw) == 0 {
		return 1.0
	}
	var m struct {
		Product         string `json:"product"`
		BoostMultiplier string `json:"boostMultiplier"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return 1.0
	}
	if m.Product != "combo" || m.BoostMultiplier == "" {
		return 1.0
	}
	v, err := strconv.ParseFloat(m.BoostMultiplier, 64)
	if err != nil || v <= 0 {
		return 1.0
	}
	return v
}

// publishTicketEvent is best-effort — pub/sub drops don't affect state.
func (w *Worker) publishTicketEvent(ctx context.Context, userID, ticketID, status string, reason *string) {
	payload := map[string]any{
		"type":     "ticket",
		"ticketId": ticketID,
		"status":   status,
	}
	if reason != nil {
		payload["rejectReason"] = *reason
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	if err := w.rdb.Publish(ctx, userChannelPrefix+userID, body).Err(); err != nil {
		w.log.Debug().Err(err).Msg("publish ticket event failed")
	}
}
