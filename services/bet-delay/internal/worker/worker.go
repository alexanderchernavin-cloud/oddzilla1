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

// ─── LISTEN loop ───────────────────────────────────────────────────────────

func (w *Worker) listen(ctx context.Context) {
	for ctx.Err() == nil {
		if err := w.listenOnce(ctx); err != nil && !errors.Is(err, context.Canceled) {
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
SELECT id, user_id, currency, stake_micro, not_before_ts
  FROM tickets
 WHERE id = $1 AND status = 'pending_delay'`
	var p store.PendingTicket
	err := w.pool.QueryRow(ctx, q, ticketID).Scan(&p.ID, &p.UserID, &p.Currency, &p.StakeMicro, &p.NotBeforeTs)
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

	reject, reason := w.evaluate(selections)
	if reject {
		if err := store.RejectAndRefund(ctx, tx, p.ID, p.UserID, p.Currency, reason, p.StakeMicro); err != nil {
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit reject: %w", err)
		}
		atomic.AddInt64(&w.rejected, 1)
		w.publishTicketEvent(ctx, p.UserID, p.ID, "rejected", &reason)
		w.log.Info().Str("ticket", p.ID).Str("reason", reason).Msg("ticket rejected")
		return nil
	}

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
}

// evaluate returns (rejectNeeded, reason).
func (w *Worker) evaluate(selections []store.Selection) (bool, string) {
	if len(selections) == 0 {
		return true, "no_selections"
	}
	for _, s := range selections {
		if s.MarketStatus != 1 {
			return true, "market_suspended"
		}
		if !s.OutcomeActive {
			return true, "outcome_inactive"
		}
		if s.CurrentPublished == nil || *s.CurrentPublished == "" {
			return true, "no_current_price"
		}
		placed, err1 := strconv.ParseFloat(s.OddsAtPlacement, 64)
		current, err2 := strconv.ParseFloat(*s.CurrentPublished, 64)
		if err1 != nil || err2 != nil || placed <= 0 {
			return true, "odds_parse"
		}
		drift := math.Abs(current-placed) / placed
		if drift > w.driftTolerance {
			return true, "odds_drift_exceeded"
		}
	}
	return false, ""
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
