// Periodic stale-ticket sweeper.
//
// Some tickets get left in `accepted` status long after their match
// should have ended — typically because Oddin's broker never emitted
// the bet_settlement, the message landed for a market we don't have
// (race with feed-ingester), or our consumer was offline through the
// recovery window. The sweeper handles both halves of the cleanup:
//
//   1. Recovery (RecoveryAgeHours ≤ age < VoidAgeHours after scheduled_at)
//      For each match URN with stuck `accepted` tickets, fire
//      pg_notify('fixture_refresh', urn). The feed-ingester listener
//      re-fetches the fixture from Oddin REST and updates matches.status,
//      which is the only authoritative way to mark phantom-live or
//      phantom-not_started matches as closed/cancelled. (Per-URN cooldown
//      lives inside the listener; spamming is safe.) Settlement messages
//      missed by the live AMQP consumer can also be replayed by the
//      operator hitting `/admin/feed/recovery` — that path is left to a
//      human because a global cursor rewind is heavyweight.
//
//   2. Void  (age ≥ VoidAgeHours after scheduled_at)
//      For each ticket still `accepted` with at least one stale
//      unresolved selection, void only the stale leg(s) (set result=void,
//      void_factor=1) and re-run maybeSettleTicket. Singles refund the
//      stake. Combos with one stale + one future-match leg keep the
//      ticket open until the future leg resolves; the void leg multiplies
//      as 1×, exactly like a normal bet_cancel-driven void.
//
// The sweeper runs on its own ticker (default 30 min), independent of
// the AMQP consumer. Both phases are safe to repeat under racing
// settlements: the void path uses FOR UPDATE SKIP LOCKED via the
// settler's existing maybeSettleTicket flow, and an arriving real
// settlement that beats us to the lock processes normally.

package sweeper

import (
	"context"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"

	"github.com/oddzilla/settlement/internal/settler"
	"github.com/oddzilla/settlement/internal/store"
)

const (
	// DefaultRecoveryAgeHours starts the recovery window. Esports matches
	// rarely run longer than 4h (Bo5 LoL/Dota2/CS2 majors); 5h gives
	// enough buffer that the legitimate live finish has happened before
	// we treat a ticket as suspect.
	DefaultRecoveryAgeHours = 5
	// DefaultVoidAgeHours bounds the recovery window and starts the
	// void-and-refund phase. Two days is enough for Oddin to have
	// retried any settlement message they were going to send and for
	// the operator to have noticed any larger outage.
	DefaultVoidAgeHours = 48
	// DefaultInterval matches the cadence at which we expect new matches
	// to age into the windows. Faster than this would burn pg_notify
	// for no benefit; slower would leave users waiting.
	DefaultInterval = 30 * time.Minute
	// VoidBatchLimit caps the number of tickets we void per tick so a
	// single iteration can't monopolize the worker. Stragglers are
	// picked up next tick.
	VoidBatchLimit = 200

	auditAction = "settlement.stale_ticket_void"

	userChannelPrefix = "user:"
)

// Config tunes the sweeper. Zero values fall back to sensible defaults.
type Config struct {
	RecoveryAgeHours int
	VoidAgeHours     int
	Interval         time.Duration
}

func (c Config) withDefaults() Config {
	if c.RecoveryAgeHours <= 0 {
		c.RecoveryAgeHours = DefaultRecoveryAgeHours
	}
	if c.VoidAgeHours <= c.RecoveryAgeHours {
		c.VoidAgeHours = DefaultVoidAgeHours
	}
	if c.Interval <= 0 {
		c.Interval = DefaultInterval
	}
	return c
}

// Sweeper owns the periodic loop and depends only on store + settler.
// It does not touch AMQP, so it runs even when Oddin creds are absent
// (in which case the recovery phase is best-effort — feed-ingester is
// also idle — but the void phase still refunds stuck tickets correctly).
type Sweeper struct {
	cfg     Config
	store   *store.Store
	settler *settler.Settler
	rdb     *redis.Client
	log     zerolog.Logger

	recoveryNotified int64
	tickersVoided    int64
	tickersFailed    int64
	ticks            int64
}

// New constructs the sweeper with config defaults applied.
func New(cfg Config, st *store.Store, stt *settler.Settler, rdb *redis.Client, log zerolog.Logger) *Sweeper {
	return &Sweeper{
		cfg:     cfg.withDefaults(),
		store:   st,
		settler: stt,
		rdb:     rdb,
		log:     log.With().Str("component", "stale-ticket-sweeper").Logger(),
	}
}

// Run blocks until ctx is done. Fires one immediate sweep on boot so a
// freshly-restarted worker doesn't wait the full Interval to catch up.
func (s *Sweeper) Run(ctx context.Context) {
	s.log.Info().
		Int("recovery_age_hours", s.cfg.RecoveryAgeHours).
		Int("void_age_hours", s.cfg.VoidAgeHours).
		Dur("interval", s.cfg.Interval).
		Msg("starting")
	// Small boot delay so the rest of the service finishes wiring up
	// before we hit Postgres for our first sweep.
	select {
	case <-ctx.Done():
		return
	case <-time.After(5 * time.Second):
	}
	s.tick(ctx)
	t := time.NewTicker(s.cfg.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			s.log.Info().Msg("stopping")
			return
		case <-t.C:
			s.tick(ctx)
		}
	}
}

// Stats returns a snapshot of counters for /healthz exposure.
func (s *Sweeper) Stats() (ticks, recoveryNotified, voided, failed int64) {
	return atomic.LoadInt64(&s.ticks),
		atomic.LoadInt64(&s.recoveryNotified),
		atomic.LoadInt64(&s.tickersVoided),
		atomic.LoadInt64(&s.tickersFailed)
}

func (s *Sweeper) tick(ctx context.Context) {
	atomic.AddInt64(&s.ticks, 1)
	s.recoverPhase(ctx)
	s.voidPhase(ctx)
}

// recoverPhase notifies the feed-ingester for every match URN that has
// at least one stuck `accepted` ticket inside the recovery window.
func (s *Sweeper) recoverPhase(ctx context.Context) {
	urns, err := store.StaleAcceptedMatchURNs(ctx, s.store.Pool(), s.cfg.RecoveryAgeHours, s.cfg.VoidAgeHours)
	if err != nil {
		s.log.Warn().Err(err).Msg("recover: query failed")
		return
	}
	if len(urns) == 0 {
		s.log.Debug().Msg("recover: nothing to do")
		return
	}
	s.log.Info().Int("count", len(urns)).Msg("recover: notifying fixture_refresh")
	for _, urn := range urns {
		if ctx.Err() != nil {
			return
		}
		if err := store.NotifyFixtureRefresh(ctx, s.store.Pool(), urn); err != nil {
			s.log.Warn().Err(err).Str("urn", urn).Msg("recover: pg_notify failed")
			continue
		}
		atomic.AddInt64(&s.recoveryNotified, 1)
	}
}

// voidPhase drives the per-ticket void-and-refund flow for tickets that
// have aged past the void threshold.
func (s *Sweeper) voidPhase(ctx context.Context) {
	ids, err := store.StaleAcceptedTicketIDs(ctx, s.store.Pool(), s.cfg.VoidAgeHours, VoidBatchLimit)
	if err != nil {
		s.log.Warn().Err(err).Msg("void: query failed")
		return
	}
	if len(ids) == 0 {
		s.log.Debug().Msg("void: nothing to do")
		return
	}
	s.log.Info().Int("count", len(ids)).Msg("void: voiding stale tickets")
	for _, id := range ids {
		if ctx.Err() != nil {
			return
		}
		didSettle, err := s.voidOneTicket(ctx, id)
		if err != nil {
			atomic.AddInt64(&s.tickersFailed, 1)
			s.log.Warn().Err(err).Str("ticket_id", id).Msg("void: ticket failed")
			continue
		}
		if didSettle {
			atomic.AddInt64(&s.tickersVoided, 1)
			s.publishTicketEvent(ctx, id, "settled", "stale_void")
		}
	}
}

// voidOneTicket runs the void+settle flow for a single ticket inside
// one transaction. Reuses the settler's exported helpers so payout
// math, wallet/ledger updates, and ref-id generation all match the
// AMQP-driven path. Returns (true, nil) when the ticket transitioned
// to settled in this call.
func (s *Sweeper) voidOneTicket(ctx context.Context, ticketID string) (bool, error) {
	tx, err := s.store.BeginTx(ctx)
	if err != nil {
		return false, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	voided, err := store.VoidStaleSelectionsForTicket(ctx, tx, ticketID, s.cfg.VoidAgeHours)
	if err != nil {
		return false, err
	}
	if voided == 0 {
		// Nothing was eligible — either a real settlement landed in
		// between the listing query and this transaction, or every leg
		// is on a future match (which means the candidate query made a
		// boundary mistake). Either way commit empty and move on.
		return false, tx.Commit(ctx)
	}

	didSettle, err := s.settler.MaybeSettleTicketTx(ctx, tx, ticketID, "stale_void")
	if err != nil {
		return false, err
	}

	auditPayload, _ := json.Marshal(map[string]any{
		"ticket_id":      ticketID,
		"void_age_hours": s.cfg.VoidAgeHours,
		"selections":     voided,
		"settled":        didSettle,
	})
	if err := store.InsertAdminAudit(ctx, tx,
		auditAction, "ticket", ticketID, nil, auditPayload,
	); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("commit: %w", err)
	}
	return didSettle, nil
}

// publishTicketEvent mirrors the settler's pub/sub fan-out so the user's
// open WebSocket session sees the void in real time.
func (s *Sweeper) publishTicketEvent(ctx context.Context, ticketID, status, reason string) {
	var userID string
	if err := s.store.Pool().QueryRow(ctx, `SELECT user_id FROM tickets WHERE id = $1`, ticketID).Scan(&userID); err != nil {
		return
	}
	body, err := json.Marshal(map[string]any{
		"type":         "ticket",
		"ticketId":     ticketID,
		"status":       status,
		"rejectReason": reason,
	})
	if err != nil {
		return
	}
	if err := s.rdb.Publish(ctx, userChannelPrefix+userID, body).Err(); err != nil {
		s.log.Debug().Err(err).Msg("publish ticket event failed")
	}
}
