// Dispatcher from raw AMQP body → typed message → side effects.
//
// Top-level routing uses PeekKind to choose the struct to unmarshal into.
// Each handler is purpose-built; settlement / cancel / rollback messages
// are recognized and logged here but NOT applied — that's settlement's job
// (phase 6). We do still bump amqp_state so they count toward recovery.

package handler

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"math/rand"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"github.com/oddzilla/feed-ingester/internal/automap"
	"github.com/oddzilla/feed-ingester/internal/bus"
	"github.com/oddzilla/feed-ingester/internal/oddinrest"
	"github.com/oddzilla/feed-ingester/internal/oddinxml"
	"github.com/oddzilla/feed-ingester/internal/store"
)

// AliveState tracks the last alive-message timestamp per producer so the
// handler can detect irregular gaps and trigger recovery. Per Oddin docs
// §2.4.7: alive arrives every 10s; intervals more or less than ~10s
// indicate either networking issues or a producer-side problem and the
// client must suspend markets and recover.
type AliveState struct {
	lastTsMs sync.Map // int (product) → int64 (last unix ms timestamp)
}

func NewAliveState() *AliveState { return &AliveState{} }

// observe updates the per-producer last-ts and returns the gap (in ms)
// since the previous alive for the same producer. Returns (0, false) on
// the first alive received for a producer (no prior to compare against).
func (a *AliveState) observe(product int, tsMs int64) (int64, bool) {
	prev, loaded := a.lastTsMs.Swap(product, tsMs)
	if !loaded {
		return 0, false
	}
	return tsMs - prev.(int64), true
}

type Deps struct {
	Store    *store.Store
	Resolver *automap.Resolver
	Bus      *bus.Bus
	Log      zerolog.Logger
	Rest     *oddinrest.Client // optional; nil disables recovery flow
	NodeID   int               // identifies this consumer to Oddin's recovery
	Alive    *AliveState       // per-producer alive-gap tracker
}

// Handle is the entry point from the AMQP consumer. Never returns an error
// for messages we don't own (settlement etc.) — that would requeue them
// infinitely. It only errors on transient DB/Redis failures the caller
// should retry.
func Handle(ctx context.Context, d Deps, routingKey string, body []byte) error {
	kind, err := oddinxml.PeekKind(body)
	if err != nil {
		d.Log.Warn().Err(err).Str("rk", routingKey).Msg("unrecognized message; dropping")
		return nil
	}

	// Persist a raw copy of every match-scoped message for the admin
	// /admin/logs panel. System-level kinds (alive, snapshot_complete,
	// unknown) are skipped — they're not useful per-match replay.
	if isMatchScopedKind(kind) {
		urn, product, perr := oddinxml.PeekEvent(body)
		if perr == nil {
			if ierr := store.InsertFeedMessage(ctx, d.Store.Pool(), store.FeedMessageInsert{
				EventURN:   urn,
				Kind:       kind.String(),
				RoutingKey: routingKey,
				Product:    int16(product),
				PayloadXML: body,
			}); ierr != nil {
				// Non-fatal — the message itself still needs to flow
				// through its type handler. Admin log is best-effort.
				d.Log.Warn().Err(ierr).Str("kind", kind.String()).Msg("feed_messages insert failed; continuing")
			}
		}
	}

	switch kind {
	case oddinxml.KindOddsChange:
		return handleOddsChange(ctx, d, body)

	case oddinxml.KindFixtureChange:
		return handleFixtureChange(ctx, d, body)

	case oddinxml.KindBetStop:
		return handleBetStop(ctx, d, body)

	case oddinxml.KindAlive:
		return handleAlive(ctx, d, body)

	case oddinxml.KindSnapshotComplete:
		return handleSnapshotComplete(ctx, d, body)

	case oddinxml.KindBetSettlement,
		oddinxml.KindBetCancel,
		oddinxml.KindRollbackBetSettlement,
		oddinxml.KindRollbackBetCancel:
		// Settlement worker owns these. Log + ack.
		d.Log.Debug().Str("kind", kind.String()).Str("rk", routingKey).Msg("settlement-domain; ignored by ingester")
		return nil

	default:
		d.Log.Warn().Str("rk", routingKey).Msg("unknown message kind; dropping")
		return nil
	}
}

// ─── odds_change ──────────────────────────────────────────────────────────

func handleOddsChange(ctx context.Context, d Deps, body []byte) error {
	var msg oddinxml.OddsChange
	if err := xml.Unmarshal(body, &msg); err != nil {
		d.Log.Warn().Err(err).Msg("odds_change: unmarshal failed; dropping")
		return nil
	}
	if msg.Odds == nil || len(msg.Odds.Markets) == 0 {
		return nil
	}

	// Don't overwrite the match status from odds_change. Per the Oddin
	// docs, score-correction odds_change messages can arrive AFTER a match
	// is closed; reactivating the match in that case is a known anti-
	// pattern. ResolveMatch() will leave the existing status intact when
	// the URN is already known. For new matches, the REST fetch inside
	// ResolveMatch will set a more accurate status than the assumption
	// "live".
	matchID, err := d.Resolver.ResolveMatch(ctx, automap.MatchContext{
		MatchURN: msg.EventID,
	}, body)
	if err != nil {
		if errors.Is(err, automap.ErrSportBlocked) {
			// Out-of-scope sport (e.g. efootballbots). Ack + drop without
			// persisting. Advance the after-ts so recovery doesn't replay
			// this message forever.
			if bumpErr := store.BumpAfterTs(ctx, d.Store.Pool(), afterTsKey(msg.Product), msg.Timestamp); bumpErr != nil {
				d.Log.Warn().Err(bumpErr).Msg("bump after_ts failed on blocked-sport drop")
			}
			return nil
		}
		return fmt.Errorf("resolve match %s: %w", msg.EventID, err)
	}

	events := make([]bus.OddsEvent, 0, 32)

	for _, m := range msg.Odds.Markets {
		specs := oddinxml.Parse(m.Specifiers)
		canonical := oddinxml.Canonical(specs)
		hash := oddinxml.Hash(specs)

		marketID, err := store.UpsertMarket(ctx, d.Store.Pool(), store.MarketUpsert{
			Key: store.MarketKey{
				MatchID:          matchID,
				ProviderMarketID: m.ID,
				SpecifiersHash:   hash,
			},
			SpecifiersJSON: specs,
			Status:         int16(m.Status),
			LastOddinTs:    msg.Timestamp,
		})
		if err != nil {
			return fmt.Errorf("upsert market: %w", err)
		}

		// Outcomes
		rows := make([]store.OutcomeUpsert, 0, len(m.Outcomes))
		history := make([]store.OddsHistoryRow, 0, len(m.Outcomes))
		ts := time.UnixMilli(msg.Timestamp).UTC()
		for _, o := range m.Outcomes {
			rawOdds := nullableOdds(o.Odds)
			probability := nullableProbability(o.Probability)
			active := o.Active == nil || *o.Active == 1
			rows = append(rows, store.OutcomeUpsert{
				MarketID:    marketID,
				OutcomeID:   o.ID,
				Name:        o.Name,
				RawOdds:     rawOdds,
				Probability: probability,
				Active:      active,
				LastOddinTs: msg.Timestamp,
			})
			history = append(history, store.OddsHistoryRow{
				MarketID:    marketID,
				OutcomeID:   o.ID,
				RawOdds:     rawOdds,
				Probability: probability,
				Ts:          ts,
			})
			if rawOdds != nil {
				ev := bus.OddsEvent{
					MarketID:            marketID,
					OutcomeID:           o.ID,
					ProviderMarketID:    m.ID,
					SpecifiersCanonical: canonical,
					RawOdds:             *rawOdds,
					Active:              active,
					MatchID:             matchID,
					OddinTs:             msg.Timestamp,
				}
				if probability != nil {
					ev.Probability = *probability
				}
				events = append(events, ev)
			}
		}
		if err := store.UpsertOutcomes(ctx, d.Store.Pool(), rows); err != nil {
			return fmt.Errorf("upsert outcomes: %w", err)
		}
		if err := store.AppendOddsHistory(ctx, d.Store.Pool(), history); err != nil {
			// Log + continue. History is nice-to-have; live state is more
			// important. Retrying would stall the consumer.
			d.Log.Warn().Err(err).Msg("odds_history append failed; continuing")
		}
	}

	if len(events) > 0 {
		if err := d.Bus.PublishOddsBatch(ctx, events); err != nil {
			d.Log.Warn().Err(err).Msg("bus publish failed; continuing (Postgres is source of truth)")
		}
	}

	if err := store.BumpAfterTs(ctx, d.Store.Pool(), afterTsKey(msg.Product), msg.Timestamp); err != nil {
		d.Log.Warn().Err(err).Msg("bump after_ts failed")
	}

	return nil
}

// ─── fixture_change ───────────────────────────────────────────────────────

func handleFixtureChange(ctx context.Context, d Deps, body []byte) error {
	var msg oddinxml.FixtureChange
	if err := xml.Unmarshal(body, &msg); err != nil {
		d.Log.Warn().Err(err).Msg("fixture_change: unmarshal failed; dropping")
		return nil
	}

	var scheduled time.Time
	if msg.StartTime != nil {
		scheduled = time.UnixMilli(*msg.StartTime).UTC()
	}

	newStatus := mapFixtureStatus(msg.ChangeType)
	matchID, err := d.Resolver.ResolveMatch(ctx, automap.MatchContext{
		MatchURN:    msg.EventID,
		ScheduledAt: scheduled,
		Status:      newStatus,
	}, body)
	if err != nil {
		if errors.Is(err, automap.ErrSportBlocked) {
			// Out-of-scope sport — ack and drop (no status to apply, no
			// REST refresh to trigger). Pre-existing matches are handled
			// inside RefreshFromFixture itself.
			return nil
		}
		return fmt.Errorf("fixture_change: resolve: %w", err)
	}

	// ResolveMatch only sets status on insert; for an existing match we
	// must apply the status change explicitly. Per Oddin docs, change_type
	// 3 (CANCELLED) is the only fixture_change value that mutates status
	// directly via this handler.
	if newStatus != "" {
		if err := store.UpdateMatchStatus(ctx, d.Store.Pool(), matchID, newStatus); err != nil {
			d.Log.Warn().Err(err).Int64("match_id", matchID).
				Str("status", newStatus).Msg("update match status failed")
		}
	}

	// Per Oddin docs §2.4.6: "We strongly recommend that you always
	// re-fetch the fixture information for the affected match if you
	// receive [a fixture_change]." Do this for the change types that
	// actually mutate fixture metadata: NEW (1), DATE_TIME (2), FORMAT
	// (4), and COVERAGE (5). CANCELLED (3) is already handled above and
	// STREAM_URL (106) doesn't affect bet placement.
	if shouldRefreshFromREST(msg.ChangeType) {
		if err := d.Resolver.RefreshFromFixture(ctx, msg.EventID); err != nil {
			d.Log.Debug().Err(err).Str("match_urn", msg.EventID).
				Str("change_type", msg.ChangeType).
				Msg("fixture_change: REST refresh failed (best-effort; continuing)")
		}
	}

	if err := store.BumpAfterTs(ctx, d.Store.Pool(), afterTsKey(msg.Product), msg.Timestamp); err != nil {
		d.Log.Warn().Err(err).Msg("bump after_ts failed")
	}
	return nil
}

// ─── bet_stop ─────────────────────────────────────────────────────────────

// bet_stop suspends a whole group of markets for a match. For phase 3 we
// don't yet know which markets a group applies to (needs market_descriptions
// REST). We log + bump cursor so settlement/publisher can pick it up later.
func handleBetStop(ctx context.Context, d Deps, body []byte) error {
	var msg oddinxml.BetStop
	if err := xml.Unmarshal(body, &msg); err != nil {
		d.Log.Warn().Err(err).Msg("bet_stop: unmarshal failed; dropping")
		return nil
	}
	d.Log.Info().
		Str("event", msg.EventID).
		Str("groups", msg.Groups).
		Int("market_status", msg.MarketStatus).
		Msg("bet_stop received (phase 3: log only; phase 4 will apply)")

	if err := store.BumpAfterTs(ctx, d.Store.Pool(), afterTsKey(msg.Product), msg.Timestamp); err != nil {
		d.Log.Warn().Err(err).Msg("bump after_ts failed")
	}
	return nil
}

// ─── alive ────────────────────────────────────────────────────────────────

func handleAlive(ctx context.Context, d Deps, body []byte) error {
	var msg oddinxml.Alive
	if err := xml.Unmarshal(body, &msg); err != nil {
		return nil
	}
	d.Log.Debug().
		Int("product", msg.Product).
		Int("subscribed", msg.Subscribed).
		Int64("ts", msg.Timestamp).
		Msg("alive")
	// subscribed=0 means Oddin's producer just came back up after a
	// downtime (or we lost our subscription). Per the docs we should
	// initiate a full recovery immediately and keep markets closed until
	// snapshot_complete arrives.
	if msg.Subscribed == 0 && d.Rest != nil {
		d.Log.Warn().Int("product", msg.Product).
			Msg("alive subscribed=0; triggering recovery for this producer")
		go triggerRecoveryForProduct(context.Background(), d, msg.Product)
	}
	// Timestamp-gap detection. Per Oddin docs §2.4.7, alive arrives every
	// 10s; if consecutive timestamps drift by more than ~5s in either
	// direction we should treat that as a producer-side issue and
	// recover. We don't suspend markets here — bet placement already
	// rejects on market.status != 1 — but we re-issue recovery so any
	// missed messages stream back through.
	if d.Alive != nil && d.Rest != nil {
		const (
			expectedIntervalMs = int64(10_000)
			toleranceMs        = int64(5_000)
		)
		if gap, ok := d.Alive.observe(msg.Product, msg.Timestamp); ok {
			drift := gap - expectedIntervalMs
			if drift < 0 {
				drift = -drift
			}
			if drift > toleranceMs {
				d.Log.Warn().Int("product", msg.Product).
					Int64("gap_ms", gap).Int64("expected_ms", expectedIntervalMs).
					Msg("alive gap exceeds tolerance; triggering recovery")
				go triggerRecoveryForProduct(context.Background(), d, msg.Product)
			}
		}
	}
	// Don't bump after_ts from alive — it's a heartbeat, not a data point.
	return nil
}

// ─── recovery ─────────────────────────────────────────────────────────────

// TriggerRecovery is called once after each AMQP (re)connect. It walks both
// producers and asks Oddin to replay any messages since our stored cursor.
// Errors are logged but never bubble up — the live feed continues either
// way.
func TriggerRecovery(ctx context.Context, d Deps, log zerolog.Logger) {
	for _, p := range []int{1, 2} {
		triggerRecoveryForProduct(ctx, d, p)
	}
}

func triggerRecoveryForProduct(ctx context.Context, d Deps, product int) {
	if d.Rest == nil {
		return
	}
	productName := producerName(product)
	if productName == "" {
		return
	}
	afterMs, err := store.ReadAfterTs(ctx, d.Store.Pool(), afterTsKey(product))
	if err != nil {
		d.Log.Warn().Err(err).Int("product", product).Msg("recovery: read cursor failed")
		// Fall through with afterMs=0 so Oddin sends just current state.
	}
	requestID := int(rand.Int31n(1_000_000_000)) //nolint:gosec // not security-sensitive
	if err := d.Rest.InitiateRecovery(ctx, productName, afterMs, requestID, d.NodeID); err != nil {
		d.Log.Warn().Err(err).Int("product", product).
			Int64("after_ms", afterMs).Int("request_id", requestID).
			Msg("recovery: initiate_request failed")
		return
	}
	d.Log.Info().Int("product", product).Int64("after_ms", afterMs).
		Int("request_id", requestID).Msg("recovery: initiate_request sent")
}

func producerName(product int) string {
	switch product {
	case 1:
		return "pre"
	case 2:
		return "live"
	}
	return ""
}

// ─── snapshot_complete ────────────────────────────────────────────────────

func handleSnapshotComplete(ctx context.Context, d Deps, body []byte) error {
	var msg oddinxml.SnapshotComplete
	if err := xml.Unmarshal(body, &msg); err != nil {
		return nil
	}
	d.Log.Info().
		Int("product", msg.Product).
		Int64("request_id", msg.RequestID).
		Int64("ts", msg.Timestamp).
		Msg("snapshot complete")

	if err := store.BumpAfterTs(ctx, d.Store.Pool(), afterTsKey(msg.Product), msg.Timestamp); err != nil {
		d.Log.Warn().Err(err).Msg("bump after_ts failed")
	}
	return nil
}

// ─── helpers ──────────────────────────────────────────────────────────────

func afterTsKey(product int) string {
	// Two producers: 1 pre-match, 2 live. Distinct cursors so each resumes
	// independently.
	return fmt.Sprintf("producer:%d", product)
}

func nullableOdds(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// nullableProbability validates Oddin's `probabilities` attribute. It is a
// decimal between 0 and 1; we keep it as a string so Postgres NUMERIC stays
// authoritative. Out-of-range or unparseable values become nil (don't write
// junk to the DB; the feed is generally clean but parser drift on either
// side could otherwise pollute the column).
func nullableProbability(s string) *string {
	if s == "" {
		return nil
	}
	// Defensive parse — Oddin sends e.g. "0.368". Anything outside [0,1]
	// is meaningless and dropped.
	var f float64
	if _, err := fmt.Sscanf(s, "%f", &f); err != nil {
		return nil
	}
	if f < 0 || f > 1 {
		return nil
	}
	return &s
}

// shouldRefreshFromREST returns true for fixture_change change_types
// that materially update match metadata we cache — NEW, DATE_TIME,
// FORMAT, and COVERAGE per Oddin docs §2.4.6.
func shouldRefreshFromREST(changeType string) bool {
	switch changeType {
	case "1", "2", "4", "5", "new", "datetime", "format", "coverage":
		return true
	}
	return false
}

// isMatchScopedKind reports whether the message is bound to a specific
// event URN. Alive/snapshot_complete/unknown aren't match-scoped and are
// excluded from the admin feed log.
func isMatchScopedKind(k oddinxml.MessageKind) bool {
	switch k {
	case oddinxml.KindOddsChange,
		oddinxml.KindFixtureChange,
		oddinxml.KindBetStop,
		oddinxml.KindBetSettlement,
		oddinxml.KindBetCancel,
		oddinxml.KindRollbackBetSettlement,
		oddinxml.KindRollbackBetCancel:
		return true
	}
	return false
}

// mapFixtureStatus translates Oddin fixture_change.change_type values to
// our match_status enum. Per the Oddin docs the change_type is a numeric
// id, not a name:
//   1   NEW         — new fixture; status unchanged (REST re-fetch will fill in)
//   2   DATE_TIME   — start time changed; status unchanged
//   3   CANCELLED   — fixture cancelled; mark match cancelled
//   4   FORMAT      — Bo3 → Bo5 etc.; status unchanged
//   5   COVERAGE    — coverage changed; status unchanged
//   106 STREAM_URL  — stream URL changed; status unchanged
// When unknown / unset / "" we return "" so the resolver keeps whatever
// status the match row already has.
func mapFixtureStatus(changeType string) string {
	switch changeType {
	case "3", "cancelled":
		return "cancelled"
	default:
		return ""
	}
}

