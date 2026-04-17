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
	"fmt"
	"time"

	"github.com/rs/zerolog"

	"github.com/oddzilla/feed-ingester/internal/automap"
	"github.com/oddzilla/feed-ingester/internal/bus"
	"github.com/oddzilla/feed-ingester/internal/oddinxml"
	"github.com/oddzilla/feed-ingester/internal/store"
)

type Deps struct {
	Store    *store.Store
	Resolver *automap.Resolver
	Bus      *bus.Bus
	Log      zerolog.Logger
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

	matchID, err := d.Resolver.ResolveMatch(ctx, automap.MatchContext{
		MatchURN: msg.EventID,
		Status:   "live", // presence of odds_change implies in-play (or pre-match live)
	}, body)
	if err != nil {
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
			active := o.Active == nil || *o.Active == 1
			rows = append(rows, store.OutcomeUpsert{
				MarketID:    marketID,
				OutcomeID:   o.ID,
				Name:        o.Name,
				RawOdds:     rawOdds,
				Active:      active,
				LastOddinTs: msg.Timestamp,
			})
			history = append(history, store.OddsHistoryRow{
				MarketID:  marketID,
				OutcomeID: o.ID,
				RawOdds:   rawOdds,
				Ts:        ts,
			})
			if rawOdds != nil {
				events = append(events, bus.OddsEvent{
					MarketID:            marketID,
					OutcomeID:           o.ID,
					ProviderMarketID:    m.ID,
					SpecifiersCanonical: canonical,
					RawOdds:             *rawOdds,
					Active:              active,
					MatchID:             matchID,
					OddinTs:             msg.Timestamp,
				})
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

	_, err := d.Resolver.ResolveMatch(ctx, automap.MatchContext{
		MatchURN:    msg.EventID,
		ScheduledAt: scheduled,
		Status:      mapFixtureStatus(msg.ChangeType),
	}, body)
	if err != nil {
		return fmt.Errorf("fixture_change: resolve: %w", err)
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
	// Don't bump after_ts from alive — it's a heartbeat, not a data point.
	return nil
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

// mapFixtureStatus translates Oddin change_type values to our enum. When
// unknown (empty or a value we don't recognize), return "" so the resolver
// keeps whatever status the match row already has.
func mapFixtureStatus(changeType string) string {
	switch changeType {
	case "cancelled":
		return "cancelled"
	case "datetime", "new", "":
		return ""
	default:
		return ""
	}
}
