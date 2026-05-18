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
	"hash/fnv"
	"strconv"
	"sync"
	"sync/atomic"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
	"golang.org/x/sync/errgroup"

	"github.com/oddzilla/settlement/internal/oddinxml"
	"github.com/oddzilla/settlement/internal/store"
)

const userChannelPrefix = "user:"

// oddsChannelPrefix is the per-match fan-out channel ws-gateway forwards
// to subscribed browsers. Mirrors services/odds-publisher's PubChannelPrefix
// and feed-ingester's livescore publisher — the gateway just JSON-parses
// each payload and routes it to clients subscribed to the matching match
// id, so we can ride this channel for `marketStatus` frames without any
// changes to ws-gateway.
const oddsChannelPrefix = "odds:match:"

type Settler struct {
	store             *store.Store
	rdb               *redis.Client
	log               zerolog.Logger
	rollbackBatchSize int
	// parallelism is the worker-pool size for phase-2 chunk settle in
	// applyMarketSettle. Clamped to [1, settleMaxParallelism] at the
	// New() boundary. parallelism=1 takes a fast path that avoids the
	// goroutine + channel + mutex overhead — useful for tiny markets
	// where fan-out is just dead weight.
	parallelism int

	settled    int64
	cancelled  int64
	rolledBack int64
	skipped    int64
	errors     int64
}

// settleMaxParallelism caps the per-market settle worker pool. The
// singleton riskzilla_bank_state row is the natural ceiling — workers
// serialise on its row lock during UpdateRiskzillaBankOnSettle, so the
// marginal benefit beyond 4-6 workers tapers off quickly. 8 is a hard
// ceiling for runaway-config safety; the env clamp respects it.
const settleMaxParallelism = 8

func New(st *store.Store, rdb *redis.Client, rollbackBatch, parallelism int, log zerolog.Logger) *Settler {
	if parallelism < 1 {
		parallelism = 1
	}
	if parallelism > settleMaxParallelism {
		parallelism = settleMaxParallelism
	}
	return &Settler{
		store:             st,
		rdb:               rdb,
		log:               log.With().Str("component", "settler").Logger(),
		rollbackBatchSize: rollbackBatch,
		parallelism:       parallelism,
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
		oddinxml.KindMatchStatusChange,
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

	// After every bet_settlement, check whether the match is now wholly
	// terminal — every market in -3 (settled) or -4 (cancelled). Per
	// Oddin's spec the match disappears from odds_change once every
	// market settles, so a final <sport_event_status status="4"> may
	// never arrive. The all-markets-terminal predicate inside
	// MarkMatchClosedIfAllMarketsTerminal makes this safe to call
	// unconditionally: per-map market settlements during a live match
	// won't false-positive because the match-winner market is still at
	// status=1.
	if err := store.MarkMatchClosedIfAllMarketsTerminal(ctx, s.store.Pool(), msg.EventID); err != nil {
		s.log.Warn().Err(err).Str("event", msg.EventID).
			Msg("bet_settlement: mark match closed (all-terminal) failed; continuing")
	}
	return nil
}

// settleTicketChunkSize bounds the number of per-ticket settles inside
// one Postgres transaction. The single-tx form (audit H6 TODO predecessor)
// exhausted shared memory at ~100K tickets on a single market settle, so
// we split into chunks that each fit comfortably under the default lock
// table + buffer headroom. Each chunk does roughly chunkSize × 5–7 SQL
// operations (ticket UPDATE + wallet UPDATE + ledger INSERT + bank UPDATE
// + projection UPSERT + achievement INSERT) — at 200 tickets/chunk that's
// ~1.5K ops per tx, well within default pg shared mem.
const settleTicketChunkSize = 200

func (s *Settler) applyMarketSettle(ctx context.Context, eventURN string, ts int64, rawBody []byte, market oddinxml.Market) error {
	specs := oddinxml.Parse(market.Specifiers)
	specsHash := oddinxml.Hash(specs)

	payloadHash := hashMarketPayload("settle", eventURN, market)
	payloadJSON, _ := json.Marshal(marketAuditPayload(eventURN, ts, market))

	// ── PHASE 1: market metadata + outcome cascade in a single tx ──────
	//
	// Keeps the small-write-set apply-once contract intact:
	//   • InsertIfNew on settlements is the per-market idempotency gate.
	//   • SetMarketStatus + UpdateOutcomeResult + ApplyOutcomeToSelections
	//     are all idempotent (UPDATE…WHERE result IS NULL etc.), safe on
	//     replay.
	//   • An advisory lock on the marketID serialises against any
	//     concurrent settle/cancel for the same market — replaces the
	//     implicit serialisation the old single-tx provided for free.
	//
	// AffectedTicketsForMarket runs inside this tx so the ticket list is
	// captured from the post-cascade snapshot (committed in the same tx).
	var (
		marketID       int64
		matchID        int64
		inserted       bool
		tickets        []string
		marketNotFound bool
	)
	err := func() error {
		tx, err := s.store.BeginTx(ctx)
		if err != nil {
			return fmt.Errorf("begin tx phase1: %w", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()

		mID, ok, err := store.FindMarket(ctx, tx, eventURN, market.ID, specsHash)
		if err != nil {
			return err
		}
		if !ok {
			marketNotFound = true
			return tx.Commit(ctx)
		}
		marketID = mID

		// Per-market advisory lock. Held until tx commits, preventing two
		// AMQP-driven settles/cancels for the same market from racing the
		// outcome cascade. The old single-tx form got this for free via
		// the long-lived tx + row locks; we restore it explicitly now
		// that phase 2 commits per-chunk.
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", marketID); err != nil {
			return fmt.Errorf("advisory lock: %w", err)
		}

		_, ins, err := store.InsertIfNew(ctx, tx, store.SettlementInsert{
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
		inserted = ins

		// Fresh settle: apply the outcome cascade. On replay (inserted=
		// false) we skip it — the cascade is idempotent but skipping
		// avoids redundant index probes on the partial WHERE result IS
		// NULL filter. We still fetch the ticket list below so phase 2
		// can catch tickets stranded by a previous crash.
		if inserted {
			mid, err := store.SetMarketStatus(ctx, tx, marketID, -3, ts)
			if err != nil {
				return err
			}
			matchID = mid
			for _, o := range market.Outcomes {
				result := mapOutcomeResult(o.Result, o.VoidFactor)
				if err := store.UpdateOutcomeResult(ctx, tx, marketID, o.ID, result, o.VoidFactor, ts); err != nil {
					return err
				}
				if err := store.ApplyOutcomeToSelections(ctx, tx, marketID, o.ID, result, o.VoidFactor); err != nil {
					return err
				}
			}
		}

		ts2, err := store.AffectedTicketsForMarket(ctx, tx, marketID)
		if err != nil {
			return err
		}
		tickets = ts2
		return tx.Commit(ctx)
	}()
	if err != nil {
		return err
	}
	if marketNotFound {
		// Oddin settled a market we don't have yet — happens when a
		// settlement beats the ingester on a fresh fixture. Drop
		// silently; the market will resolve when it arrives.
		atomic.AddInt64(&s.skipped, 1)
		s.log.Debug().Str("event", eventURN).Int("market", market.ID).Msg("market unknown; skipping")
		return nil
	}

	// Phase 1 committed. Broadcast the market-status flip so any browser
	// holding this match's match page can lock the now-settled market in
	// the same render tick. Gated on `inserted` because a replay didn't
	// actually write a new status — clients already saw the first frame.
	if inserted {
		s.publishMarketStatus(ctx, matchID, marketID, -3, ts)
	}

	// ── PHASE 2: settle each ticket in chunked transactions ────────────
	//
	// Each chunk is its own tx so the per-tx write set stays bounded. If
	// a chunk fails partway, prior chunks remain committed and a replay
	// (same AMQP message redelivered) picks up exactly the un-settled
	// tickets — maybeSettleTicket's LoadTicketWithSelections uses
	// FOR UPDATE SKIP LOCKED + status='accepted', so already-settled
	// tickets are no-ops on re-entry.
	//
	// Note: phase 1 may have committed with inserted=false on a replay,
	// meaning the outcome cascade was skipped this round. The ticket
	// list still reflects all selections on this market; the per-ticket
	// settle below sees the already-applied selection results from a
	// prior successful run.
	//
	// Worker-pool fan-out (audit H6 follow-up): up to s.parallelism
	// goroutines drain a chunk queue, each running settleTicketChunk
	// inside its own transaction. SKIP LOCKED + status='accepted' on
	// the per-ticket load make cross-worker races no-ops; lock order
	// is identical across workers (ticket → wallet → bank_state) so
	// no deadlock potential. Workers contend on the singleton
	// riskzilla_bank_state row — that's the throughput ceiling for
	// this design, expected and acceptable.
	settledTickets, err := s.settleTicketsInParallel(ctx, tickets)
	if err != nil {
		return fmt.Errorf("phase 2 parallel settle: %w", err)
	}

	if !inserted && len(settledTickets) == 0 {
		// Pure replay with nothing left to do — preserve the legacy
		// "skipped" metric so dashboards keep reading the same shape.
		atomic.AddInt64(&s.skipped, 1)
	}

	atomic.AddInt64(&s.settled, int64(len(settledTickets)))
	for _, tid := range settledTickets {
		s.publishTicketEvent(ctx, tid, "settled", "")
	}
	// Wake the api push-notification worker so it drains any winning-ticket
	// rows we just committed (migration 0057). Cheap NOTIFY: the worker
	// no-ops if no pending rows match. Best-effort — a missed notify is
	// caught by the worker's 30 s sweep. Gated on len(settled) > 0 so we
	// don't wake the worker for pure replays.
	if len(settledTickets) > 0 {
		if err := store.NotifyPushOutbox(ctx, s.store.Pool()); err != nil {
			s.log.Debug().Err(err).Msg("notify push outbox failed; sweep will catch up")
		}
	}
	return nil
}

// settleTicketsInParallel fans the ticket list out across s.parallelism
// goroutines. Returns the union of tickets that transitioned to settled
// this call (caller publishes ticket events from this set).
//
// Concurrency model — partition-by-user, not channel-fan-out:
//   - SettleTicket UPDATEs the `wallets` row keyed by (user_id, currency).
//     If two workers each hold the wallet lock for one user and try to
//     acquire the lock for the other (different lock-acquisition orders
//     across goroutines), Postgres detects the deadlock and aborts one
//     transaction — the whole settle nacks and requeues, retries hit
//     the same pattern, settle is stuck. This is what PR #273 shipped
//     and what bit prod on 2026-05-12 (~66K-ticket settle on match
//     626479: see settlement service warn-level logs around 00:39 UTC).
//
//   - The fix is to ensure NO TWO WORKERS ever touch the same wallet.
//     We do that by partitioning tickets BY user_id (FNV-32 hash %
//     parallelism). All of user X's tickets land in the same worker;
//     within that worker they serialise on user X's wallet row in a
//     single goroutine, which Postgres handles trivially. No cross-
//     worker wallet contention → no deadlock possible.
//
//   - The riskzilla bank_state singleton row is still touched by every
//     worker on every settle, but that's a single row with serial
//     UPDATEs — Postgres row locks serialise them cleanly, no deadlock
//     pattern. This was always the design throughput ceiling.
//
//   - Per-ticket idempotency comes from maybeSettleTicket's SKIP LOCKED
//     + status='accepted' filter, unchanged.
//   - errgroup with a derived context means: first worker error
//     cancels the rest, succeeded chunks stay committed, AMQP redeliver
//     picks up gaps via the SKIP LOCKED path.
//
// Fast path: parallelism=1 OR a single chunk skips the partition + map
// + goroutine + mutex overhead and runs sequentially. Real-world most
// market settles touch under 200 tickets and take this path.
func (s *Settler) settleTicketsInParallel(ctx context.Context, tickets []string) ([]string, error) {
	if len(tickets) == 0 {
		return nil, nil
	}

	parallelism := s.parallelism
	if parallelism < 1 {
		parallelism = 1
	}

	// Single-chunk or single-worker fast path. Same behaviour as the
	// pre-parallel form — no need to spin up workers / fetch user map.
	if parallelism <= 1 || len(tickets) <= settleTicketChunkSize {
		return s.settleTicketsSequential(ctx, tickets)
	}

	// Bulk-fetch user_id per ticket so we can partition before fan-out.
	// One small SELECT vs N+1 — sub-millisecond at 100K tickets, well
	// worth it to keep the parallel path correct.
	userMap, err := s.loadTicketUserMap(ctx, tickets)
	if err != nil {
		// Fail-safe: if we can't load the user map (transient pg blip,
		// pool exhaustion, etc.), fall back to sequential rather than
		// risk the deadlock pattern again.
		s.log.Warn().Err(err).Int("tickets", len(tickets)).
			Msg("settle: user-map load failed; falling back to sequential")
		return s.settleTicketsSequential(ctx, tickets)
	}

	// Partition by FNV-32(user_id) % parallelism. FNV gives uniform-
	// enough distribution across UUID strings for our scale (100K
	// tickets across ~250 users → workers see ~25K tickets each at
	// parallelism=4, ±10% imbalance). Tickets without a user_id in
	// the map (e.g. legacy data, race with delete) fall through to
	// worker 0 — they'll still settle, just on the lightest path.
	partitions := make([][]string, parallelism)
	for _, tid := range tickets {
		uid, ok := userMap[tid]
		var idx int
		if ok {
			idx = int(fnv32(uid) % uint32(parallelism))
		}
		partitions[idx] = append(partitions[idx], tid)
	}

	// Each worker sub-chunks its partition into settleTicketChunkSize
	// transactions so per-tx write set still fits under default pg
	// lock-table / shared-buffer limits.
	var (
		mu      sync.Mutex
		settled = make([]string, 0, len(tickets))
	)
	eg, gctx := errgroup.WithContext(ctx)
	for w := 0; w < parallelism; w++ {
		partition := partitions[w]
		if len(partition) == 0 {
			continue
		}
		eg.Go(func() error {
			for i := 0; i < len(partition); i += settleTicketChunkSize {
				end := i + settleTicketChunkSize
				if end > len(partition) {
					end = len(partition)
				}
				chunk := partition[i:end]
				chunkSettled, err := s.settleTicketChunk(gctx, chunk)
				if err != nil {
					return err
				}
				if len(chunkSettled) > 0 {
					mu.Lock()
					settled = append(settled, chunkSettled...)
					mu.Unlock()
				}
			}
			return nil
		})
	}
	if err := eg.Wait(); err != nil {
		return nil, err
	}
	return settled, nil
}

// settleTicketsSequential is the fast path / fallback used when
// parallelism is 1 or we couldn't load the user map. Identical
// behaviour to the pre-parallel chunk loop from PR #270.
func (s *Settler) settleTicketsSequential(ctx context.Context, tickets []string) ([]string, error) {
	settled := make([]string, 0, len(tickets))
	for i := 0; i < len(tickets); i += settleTicketChunkSize {
		end := i + settleTicketChunkSize
		if end > len(tickets) {
			end = len(tickets)
		}
		chunk := tickets[i:end]
		chunkSettled, err := s.settleTicketChunk(ctx, chunk)
		if err != nil {
			return nil, fmt.Errorf("settle chunk %d-%d/%d: %w", i, end, len(tickets), err)
		}
		settled = append(settled, chunkSettled...)
	}
	return settled, nil
}

// loadTicketUserMap is a thin wrapper that runs the bulk user-id
// lookup in its own short-lived transaction. The result lives only in
// memory and the tx commits before fan-out, so workers don't inherit
// any locks from the lookup.
func (s *Settler) loadTicketUserMap(ctx context.Context, tickets []string) (map[string]string, error) {
	tx, err := s.store.BeginTx(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx ticket-user map: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	m, err := store.LoadTicketUserMap(ctx, tx, tickets)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit ticket-user map: %w", err)
	}
	return m, nil
}

// fnv32 hashes a string with FNV-1a. Used to partition tickets by
// user_id deterministically — same user always ends up in the same
// worker for a given parallelism value.
func fnv32(s string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(s))
	return h.Sum32()
}

// settleTicketChunk runs maybeSettleTicket for every id in `chunk` inside
// a single transaction. Returns the subset that actually transitioned to
// settled this call (the publishTicketEvent fan-out runs against this
// subset). Rolls back on the first per-ticket error so a chunk-level
// retry sees an unchanged state.
func (s *Settler) settleTicketChunk(ctx context.Context, chunk []string) ([]string, error) {
	tx, err := s.store.BeginTx(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx chunk: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	settled := make([]string, 0, len(chunk))
	for _, tid := range chunk {
		didSettle, err := s.maybeSettleTicket(ctx, tx, tid, "bet_settlement")
		if err != nil {
			return nil, err
		}
		if didSettle {
			settled = append(settled, tid)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit chunk: %w", err)
	}
	return settled, nil
}

// maybeSettleTicket returns (true, nil) if the ticket transitioned to
// settled in this tx. Returns (false, nil) if it's locked by another
// worker (SKIP LOCKED miss), already settled, or has unresolved
// selections remaining.
//
// Performance note (audit H6): the previous implementation paid three
// sequential round-trips per ticket — LoadTicketForSettle +
// UnresolvedCount + ResolvedSelections — just to decide whether to
// settle. At peak Oddin throughput (a market settle that affects N
// tickets) that was 3N round-trips before any work happened. We now
// fold all three reads into one call via LoadTicketWithSelections,
// reusing the in-memory selection slice for the unresolved-count
// predicate. The per-ticket UPDATE pipeline (SettleTicket → bank →
// projection → achievements) remains sequential — see the H6 TODO at
// the bottom of this function for the deferred batching follow-up.
func (s *Settler) maybeSettleTicket(ctx context.Context, tx pgx.Tx, ticketID, sourceTag string) (bool, error) {
	t, selections, locked, err := store.LoadTicketWithSelections(ctx, tx, ticketID)
	if err != nil {
		return false, err
	}
	if !locked {
		return false, nil
	}
	if t.Status != "accepted" {
		// Already in a terminal state. Includes:
		//   settled / voided / rejected — nothing more to do
		//   cashed_out                  — user already paid via cashout;
		//                                 settlement should not double-pay
		//                                 even if the underlying market
		//                                 settles afterwards
		//   pending_delay               — shouldn't happen (bet-delay
		//                                 advances first); ignore safely
		return false, nil
	}
	if store.UnresolvedCountIn(selections) > 0 {
		return false, nil
	}

	payout, ledgerType, err := computePayout(t, selections)
	if err != nil {
		return false, err
	}

	if err := store.SettleTicket(ctx, tx, t, payout, ledgerType, sourceTag); err != nil {
		return false, err
	}

	// Push-notification intent for winning tickets. Migration 0057 outbox
	// pattern: row committed atomically with the settle; api worker drains
	// it via LISTEN/NOTIFY (s.notifyPushOutbox after the chunk tx commits)
	// and dispatches via Firebase Admin SDK. Apply-once via the
	// (kind, ticket_id) unique partial index — settlement replay is a
	// no-op. Win is `payout > stake` so half-wins push (wallet went up)
	// and full-loss / void / half-lost don't.
	//
	// Best-effort inside the settle tx — a push-outbox failure must NOT
	// unwind the wallet credit. The 30 s api-side sweep recovers any
	// missed NOTIFY; only a hard SQL error here (FK violation, etc.)
	// would prevent the row from ever landing, and we log it.
	if payout > t.StakeMicro {
		betWonPayload := store.BetWonPushPayload{
			Kind:                 "bet_won",
			TicketID:             t.ID,
			BetType:              t.BetType,
			Currency:             t.Currency,
			StakeMicro:           strconv.FormatInt(t.StakeMicro, 10),
			ActualPayoutMicro:    strconv.FormatInt(payout, 10),
			PotentialPayoutMicro: strconv.FormatInt(t.PotentialPayoutMicro, 10),
			NumLegs:              len(selections),
		}
		if err := store.EnqueueBetWonPush(ctx, tx, t.UserID, betWonPayload); err != nil {
			s.log.Warn().Err(err).Str("ticket", t.ID).
				Msg("enqueue push notification failed; continuing")
		}
		// In-app bell (web parity with mobile push). Same tx so an
		// aborted settle can't leave a phantom bell entry. Same
		// best-effort posture — a bell write failure must not unwind
		// the wallet credit. Migration 0059 added the bet_won enum
		// value; this is its only Go-side writer.
		if err := store.EnqueueBetWonBellNotification(ctx, tx, t.UserID, betWonPayload); err != nil {
			s.log.Warn().Err(err).Str("ticket", t.ID).
				Msg("enqueue bet_won bell notification failed; continuing")
		}
		// Global Big Win fan-out. Fires only when profit clears the
		// per-currency floor (matches the storefront Big Wins feed
		// gate in V1). Writes one notification row per non-AI, non-
		// bettor user with pref_community_highlights ON, gated by a
		// 1-hour per-recipient cool-down. Skips entirely when the
		// bettor isn't publicly visible — see EnqueueBigWinFanout.
		// Migration 0067 added the big_win_landed enum value.
		profit := payout - t.StakeMicro
		if profit >= store.BigWinFloorMicro(t.Currency) {
			if err := store.EnqueueBigWinFanout(ctx, tx, store.BigWinFanoutArgs{
				BettorUserID:      t.UserID,
				TicketID:          t.ID,
				Currency:          t.Currency,
				StakeMicro:        strconv.FormatInt(t.StakeMicro, 10),
				ActualPayoutMicro: strconv.FormatInt(payout, 10),
			}); err != nil {
				s.log.Warn().Err(err).Str("ticket", t.ID).
					Msg("enqueue big_win fanout failed; continuing")
			}
		}
	}

	// RiskZilla bank update (migration 0037). Decrements open_liability
	// by the ticket's potential_payout, moves bank_limit by
	// (stake − payout), writes the ledger row keyed by ticketID:N to
	// stay idempotent under settle / rollback / re-settle.
	bankKind := "bet_payout"
	if payout == 0 {
		bankKind = "bet_loss"
	} else if ledgerType == "bet_refund" {
		bankKind = "bet_refund"
	}
	if err := store.UpdateRiskzillaBankOnSettle(
		ctx, tx, t.ID, t.Currency, t.StakeMicro, payout, t.PotentialPayoutMicro, bankKind,
	); err != nil {
		// Best-effort — a riskzilla bank failure must not unwind a real
		// settlement (the wallet/ledger is already correct). The
		// /admin/riskzilla/bank/recompute endpoint can rebuild
		// open_liability + bank_limit from the underlying tickets +
		// wallet_ledger if a write here is silently dropped.
		s.log.Warn().Err(err).Str("ticket", t.ID).
			Msg("riskzilla bank update failed; continuing")
	}

	// Phase 10.2 community projection. Best-effort inside the settle tx —
	// a projection failure must not unwind a real settlement, so we log
	// and continue. The admin backfill endpoint (POST /admin/community/
	// backfill) recovers any miss.
	if err := store.WriteCommunityProjection(ctx, tx, t.ID); err != nil {
		s.log.Warn().Err(err).Str("ticket", t.ID).
			Msg("community projection write failed; continuing")
	}
	// Phase 10.4 achievement evaluation. Idempotent on the (user_id,
	// achievement_id) composite PK — re-runs are no-ops. Best-effort
	// for the same reason as the projection write.
	if err := store.EvaluateAchievements(ctx, tx, t.ID); err != nil {
		s.log.Warn().Err(err).Str("ticket", t.ID).
			Msg("achievement evaluation failed; continuing")
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

	// Same all-terminal check as bet_settlement — a bet_cancel that
	// closes the last remaining bettable market should also flip the
	// match. Unconditional / forward-only / no-op when active markets
	// remain.
	if err := store.MarkMatchClosedIfAllMarketsTerminal(ctx, s.store.Pool(), msg.EventID); err != nil {
		s.log.Warn().Err(err).Str("event", msg.EventID).
			Msg("bet_cancel: mark match closed (all-terminal) failed; continuing")
	}
	return nil
}

func (s *Settler) applyMarketCancel(ctx context.Context, eventURN string, ts int64, rawBody []byte, market oddinxml.Market) error {
	specs := oddinxml.Parse(market.Specifiers)
	specsHash := oddinxml.Hash(specs)

	payloadHash := hashMarketPayload("cancel", eventURN, market)
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

	// Per the Oddin docs (§2.4.4), the bet_cancel time attributes determine
	// market lifecycle and which bets to void:
	//   - no times present:      cancel ALL bets; market → -4 (cancelled)
	//   - start_time only:       cancel bets placed AFTER start; market → -4
	//   - end_time only:         cancel bets placed BEFORE end; market stays active
	//   - start_time + end_time: cancel bets placed during window; market stays active
	deactivateMarket := market.EndTime == nil // true when end_time absent
	var matchIDForPublish int64
	if deactivateMarket {
		mid, err := store.SetMarketStatus(ctx, tx, marketID, -4, ts)
		if err != nil {
			return err
		}
		matchIDForPublish = mid
	}

	settledTickets, err := s.applyCancelToTickets(ctx, tx, marketID, market.StartTime, market.EndTime)
	if err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit cancel: %w", err)
	}

	if deactivateMarket {
		// market.status flipped to -4; storefront subscribers learn here.
		s.publishMarketStatus(ctx, matchIDForPublish, marketID, -4, ts)
	}

	atomic.AddInt64(&s.cancelled, int64(len(settledTickets)))
	for _, tid := range settledTickets {
		s.publishTicketEvent(ctx, tid, "settled", "market_cancelled")
	}
	return nil
}

// applyCancelToTickets handles the per-ticket void+refund flow for both
// the windowed and full bet_cancel cases. Per ticket: if currently
// settled, reverse the settlement first (so wallet/ledger unwind
// correctly per the cancel-after-settle docs note), then mark its
// selections on this market as void, then re-settle so the stake is
// refunded.
func (s *Settler) applyCancelToTickets(ctx context.Context, tx pgx.Tx, marketID int64, startMs, endMs *int64) ([]string, error) {
	tickets, err := store.AffectedTicketsForMarketInWindow(ctx, tx, marketID, startMs, endMs)
	if err != nil {
		return nil, err
	}

	settledTickets := make([]string, 0, len(tickets))
	for _, tid := range tickets {
		// Reverse if previously settled. SKIP-LOCKED misses inside
		// reverseSettledForCancel just no-op the ticket — another worker
		// has it.
		reversed, err := s.reverseSettledForCancel(ctx, tx, tid)
		if err != nil {
			return nil, err
		}
		// If we reversed a previously-settled ticket, its selections on
		// this market still hold the old result. Clear them so the
		// void-then-resettle below has clean ground.
		if reversed {
			if err := store.ReverseSelectionsForTicketOnMarket(ctx, tx, tid, marketID); err != nil {
				return nil, err
			}
		}
		if err := store.VoidSelectionsForTicketOnMarket(ctx, tx, tid, marketID); err != nil {
			return nil, err
		}
		didSettle, err := s.maybeSettleTicket(ctx, tx, tid, "bet_cancel")
		if err != nil {
			return nil, err
		}
		if didSettle {
			settledTickets = append(settledTickets, tid)
		}
	}
	return settledTickets, nil
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
	if err := store.ReverseSettledTicket(ctx, tx, ticketID, t.UserID, t.Currency, "bet_cancel", t.StakeMicro, prior); err != nil {
		return false, err
	}
	// RiskZilla bank reverse (migration 0037). Re-adds the
	// open_liability the ticket previously consumed and writes a
	// compensating ledger row.
	if err := store.UpdateRiskzillaBankOnReverse(
		ctx, tx, ticketID, t.Currency, t.StakeMicro, prior, t.PotentialPayoutMicro,
	); err != nil {
		s.log.Warn().Err(err).Str("ticket", ticketID).
			Msg("riskzilla bank reverse (bet_cancel) failed; continuing")
	}
	// Mirror the reversal onto the community projection. ON CONFLICT DO
	// UPDATE flips status='accepted' and clears payout to 0 so feed
	// queries (which filter on status IN ('settled', 'cashed_out'))
	// stop surfacing this ticket until it re-settles.
	if err := store.WriteCommunityProjection(ctx, tx, ticketID); err != nil {
		s.log.Warn().Err(err).Str("ticket", ticketID).
			Msg("community projection reverse (bet_cancel) failed; continuing")
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
	payloadHash := hashMarketPayload("rollback_settle", eventURN, market)
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
	payloadHash := hashMarketPayload("rollback_cancel", eventURN, market)
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
	matchID, err := store.SetMarketStatus(ctx, tx, marketID, 1, ts)
	if err != nil {
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
	// Re-opens the market; storefront unlocks placement on next render.
	s.publishMarketStatus(ctx, matchID, marketID, 1, ts)
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

	if err := store.ReverseSettledTicket(ctx, tx, ticketID, t.UserID, t.Currency, reason, t.StakeMicro, prior); err != nil {
		return false, err
	}
	// RiskZilla bank reverse — same shape as the bet_cancel branch.
	if err := store.UpdateRiskzillaBankOnReverse(
		ctx, tx, ticketID, t.Currency, t.StakeMicro, prior, t.PotentialPayoutMicro,
	); err != nil {
		s.log.Warn().Err(err).Str("ticket", ticketID).Str("reason", reason).
			Msg("riskzilla bank reverse (rollback) failed; continuing")
	}
	// Same reversal projection update as the bet_cancel path. Best-effort
	// inside the rollback tx — backfill recovers any miss.
	if err := store.WriteCommunityProjection(ctx, tx, ticketID); err != nil {
		s.log.Warn().Err(err).Str("ticket", ticketID).Str("reason", reason).
			Msg("community projection reverse (rollback) failed; continuing")
	}
	return true, nil
}

// ─── Helpers ───────────────────────────────────────────────────────────────

// publishMarketStatus broadcasts a market-level status change on the
// match's odds channel so the storefront can lock placement immediately
// instead of waiting for an outcome-level WS tick that may never arrive.
//
// Callers should invoke this AFTER the tx that wrote the new status
// commits — publishing inside the tx would race a subscriber who refetches
// REST state and sees the pre-commit row. Best-effort: Redis pub/sub
// drops are tolerable (the source of truth is markets.status in pg).
func (s *Settler) publishMarketStatus(ctx context.Context, matchID, marketID int64, status int16, oddinTs int64) {
	payload := map[string]any{
		"type":     "marketStatus",
		"matchId":  fmt.Sprintf("%d", matchID),
		"marketId": fmt.Sprintf("%d", marketID),
		"status":   status,
		"ts":       oddinTs,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	channel := oddsChannelPrefix + fmt.Sprintf("%d", matchID)
	if err := s.rdb.Publish(ctx, channel, body).Err(); err != nil {
		s.log.Debug().Err(err).
			Int64("match", matchID).Int64("market", marketID).
			Int16("status", status).
			Msg("publish market status failed")
	}
}

func (s *Settler) publishTicketEvent(ctx context.Context, ticketID, status, reason string) {
	// Fetch user_id + the freshly-committed actual_payout_micro in one
	// hop. Payout is non-NULL for settled / cashed_out tickets and NULL
	// otherwise; the frontend bet-history's WON/LOST/VOIDED badge derives
	// from payout-vs-stake, so omitting it on a settled WS frame causes
	// the row to render as "Lost" until the user refreshes and SSR
	// re-reads the real payout. Carrying it on the frame keeps the
	// live-update path consistent with the SSR-rendered truth.
	var (
		userID         string
		actualPayoutMu *int64
	)
	if err := s.store.Pool().QueryRow(
		ctx,
		`SELECT user_id, actual_payout_micro FROM tickets WHERE id = $1`,
		ticketID,
	).Scan(&userID, &actualPayoutMu); err != nil {
		return
	}

	payload := map[string]any{
		"type":     "ticket",
		"ticketId": ticketID,
		"status":   status,
	}
	if reason != "" {
		payload["rejectReason"] = reason
	}
	if actualPayoutMu != nil {
		// Bigint-as-string on the wire — same convention every other
		// money field uses, since JSON numbers lose precision past 2^53
		// and a settled payout for high-stake combos can exceed that.
		payload["actualPayoutMicro"] = strconv.FormatInt(*actualPayoutMu, 10)
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return
	}
	if err := s.rdb.Publish(ctx, userChannelPrefix+userID, body).Err(); err != nil {
		s.log.Debug().Err(err).Msg("publish ticket event failed")
	}
}

func hashMarketPayload(settlementType, eventURN string, market oddinxml.Market) []byte {
	// Hash a canonical representation so retries of the same data (but
	// re-serialized XML) map to the same key. We deliberately exclude
	// the raw AMQP body — including it meant two semantically-identical
	// messages with whitespace differences (e.g. broker-side
	// serializer change, or a replayed message routed through a
	// different proxy) produced different hashes, defeating the
	// `(event_urn, market_id, specifiers_hash, type, payload_hash)`
	// dedup tuple and creating a path to double-payouts on near-replays.
	// Specifier canonicalisation already covers attribute reorderings;
	// outcome iteration order is deterministic per the XML schema.
	h := sha256.New()
	fmt.Fprintf(h, "%s|%s|%d|%s", settlementType, eventURN, market.ID, market.Specifiers)
	for _, o := range market.Outcomes {
		fmt.Fprintf(h, "|%s=%s,%s", o.ID, o.Result, o.VoidFactor)
	}
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

// ComputePayoutForSmoke is a thin re-export of computePayout for the
// smoke-settle CLI in services/settlement/cmd/smoke-settle. Production
// dispatch goes through Handle → maybeSettleTicket → computePayout.
func ComputePayoutForSmoke(t store.TicketForSettle, selections []store.SelectionResult) (int64, string, error) {
	return computePayout(t, selections)
}

// computePayout returns (payoutMicro, ledgerType, err) for a ticket.
// Dispatches by bet_type. `system` tickets aren't supported yet.
func computePayout(t store.TicketForSettle, selections []store.SelectionResult) (int64, string, error) {
	switch t.BetType {
	case "single":
		if len(selections) != 1 {
			return 0, "", fmt.Errorf("single expected exactly 1 selection, got %d", len(selections))
		}
		sel := selections[0]
		payout, err := SinglePayout(t.StakeMicro, sel.OddsAtPlacement, sel.Result, sel.VoidFactor)
		if err != nil {
			return 0, "", err
		}
		return payout, LedgerTypeFor(sel.Result), nil
	case "combo":
		return ComboPayout(t.StakeMicro, t.BetMetaJSON, selections)
	case "tiple":
		return TiplePayout(t.StakeMicro, t.PotentialPayoutMicro, selections)
	case "tippot":
		return TippotPayout(t.StakeMicro, t.BetMetaJSON, selections)
	case "betbuilder":
		return BetBuilderPayout(t.StakeMicro, t.BetMetaJSON, selections)
	default:
		return 0, "", fmt.Errorf("bet_type %q not supported yet", t.BetType)
	}
}
