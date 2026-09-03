// Provider-neutral entry points for settlements that do not arrive over
// Oddin AMQP. The Fonbet ingester (services/fonbet-ingester) grades its
// markets from final scores and hands the results over the Redis stream
// `settlement.external` (see internal/extstream); this file is where those
// messages join the exact same apply path a bet_settlement / bet_cancel
// takes: apply-once `settlements` row, sticky -3/-4, outcome cascade,
// ticket grading, wallet movements, WS frames, all-terminal match close.

package settler

import (
	"context"
	"sync/atomic"

	"github.com/oddzilla/settlement/internal/oddinxml"
	"github.com/oddzilla/settlement/internal/store"
)

// ApplyExternalSettlement settles one market. `market.Specifiers` must be
// the canonical `k=v|k=v` form (sorted keys) and `market.Outcomes` sorted
// by id — both are part of the apply-once payload hash, so a producer that
// re-sends the same result must send the same bytes.
func (s *Settler) ApplyExternalSettlement(ctx context.Context, eventURN string, ts int64, market oddinxml.Market) error {
	if market.Status == 0 {
		market.Status = -3
	}
	if err := s.applyMarketSettle(ctx, eventURN, ts, nil, market); err != nil {
		atomic.AddInt64(&s.errors, 1)
		return err
	}
	if closedMatchID, closed, err := store.MarkMatchClosedIfAllMarketsTerminal(ctx, s.store.Pool(), eventURN); err != nil {
		s.log.Warn().Err(err).Str("event", eventURN).Msg("external settle: mark match closed failed; continuing")
	} else if closed {
		s.publishMatchStatus(ctx, closedMatchID, "closed", ts)
	}
	return nil
}

// ApplyExternalCancel voids one market (status -4, every selection void,
// settled tickets reversed). With nil StartTime/EndTime the whole market is
// cancelled — the shape the Fonbet ingester uses for postponed / abandoned
// events.
func (s *Settler) ApplyExternalCancel(ctx context.Context, eventURN string, ts int64, market oddinxml.Market) error {
	if market.Status == 0 {
		market.Status = -4
	}
	if err := s.applyMarketCancel(ctx, eventURN, ts, nil, market); err != nil {
		atomic.AddInt64(&s.errors, 1)
		return err
	}
	if closedMatchID, closed, err := store.MarkMatchClosedIfAllMarketsTerminal(ctx, s.store.Pool(), eventURN); err != nil {
		s.log.Warn().Err(err).Str("event", eventURN).Msg("external cancel: mark match closed failed; continuing")
	} else if closed {
		s.publishMatchStatus(ctx, closedMatchID, "closed", ts)
	}
	return nil
}
