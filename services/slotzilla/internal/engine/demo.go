// Demo games: a finished fixture's real play-by-play, replayed on a
// virtual clock that loops forever, so the section always has something
// playable whether or not real basketball is on.
//
// The design point is that a demo game is NOT a second implementation of
// the game. Everything below the clock — the window derivation, the
// paytable, the final predicate, settlement, the state frame — is the
// same code the live path runs, because the only thing a demo replaces
// is where the events and the clock come from. That is also what makes
// the demo worth having: it exercises the real engine against a real
// feed's shape, so a bug that would bite a live game bites here first.
//
// The recording is the ordinary corpus row. `sr_live_events` is keyed by
// Sportradar's own event id and the engine loads a game's events by
// `sr_match_id`, so pointing a demo game at a finished match's id is the
// whole of the storage story: fetch that timeline once, and replay from
// Postgres forever after.
//
// MONEY: a loop is perfectly predictable — one cycle in, every future
// window is known — so a demo spin is hard-gated to OZ at placement
// (services/api/src/lib/slotzilla/service.ts). Nothing here should ever
// be reachable with a real-money stake; the gate is in the api because
// that is where the wallet is debited.

package engine

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/rs/zerolog"

	"github.com/oddzilla/slotzilla/internal/rules"
	"github.com/oddzilla/slotzilla/internal/sportradar"
	"github.com/oddzilla/slotzilla/internal/store"
)

const (
	// demoCooldownSeconds is the gap between the end of one cycle and the
	// start of the next. It is not decoration: the clock stops, which
	// finalises every window the recording reached and lets settleSpins
	// pay out normally, so a bettor who spun on the last seconds of the
	// match is settled by the same path a real full-time settles. Without
	// it the clock would jump from 2400 back to 0 with spins still open
	// against windows that no longer exist.
	demoCooldownSeconds = 90

	// demoFallbackDuration is used only if a recording somehow has no
	// clocked events; it keeps the cycle arithmetic away from zero rather
	// than describing any real game.
	demoFallbackDuration = 2400

	voidDemoCycleEnded = "demo_cycle_ended"
)

// demoState is one demo game's loaded recording and where the loop is.
type demoState struct {
	// recording is every clocked event of the archived match, in the
	// engine's own shape, sorted by second so a cycle can be served with
	// a prefix scan instead of a filter over the whole slice.
	recording []Event
	duration  int
	// cycle is duration + cooldown; the period of the whole loop.
	cycle int
	// cycleIndex is which pass of the recording we last served, so a wrap
	// is detected exactly once rather than inferred from the clock going
	// backwards.
	cycleIndex int64
	loaded     bool
}

// demoPhase is where one instant falls in the loop.
type demoPhase struct {
	// Seconds is the virtual match clock.
	Seconds int
	// Running is false during the cooldown, which is what stops the game
	// accepting spins between cycles (spinBlockFor returns clock_stopped).
	Running bool
	// Ended marks the cooldown, so WindowFinal drops its clock_past
	// allowance and every window the recording reached settles.
	Ended bool
	// Index is the cycle number; a change means the loop wrapped.
	Index int64
}

// demoPhaseAt places `now` in the loop. Pure, so the cycle arithmetic is
// testable without a database or a clock.
func demoPhaseAt(epoch, now time.Time, duration int) demoPhase {
	if duration <= 0 {
		duration = demoFallbackDuration
	}
	cycle := duration + demoCooldownSeconds
	elapsed := int64(now.Sub(epoch) / time.Second)
	// A demo_epoch in the future (an operator editing the row, a clock
	// skew) must not produce a negative offset: Go's % keeps the sign of
	// the dividend, which would index backwards through the recording.
	idx := elapsed / int64(cycle)
	off := elapsed % int64(cycle)
	if off < 0 {
		off += int64(cycle)
		idx--
	}
	if off < int64(duration) {
		return demoPhase{Seconds: int(off), Running: true, Ended: false, Index: idx}
	}
	return demoPhase{Seconds: duration, Running: false, Ended: true, Index: idx}
}

// periodFor maps a virtual clock reading onto a FIBA period (4 x 10 min),
// clamped to the last period so overtime in the recording still reports a
// sensible number rather than a 5th quarter the UI has no label for.
func periodFor(seconds, duration int) *int {
	p := seconds/600 + 1
	if p < 1 {
		p = 1
	}
	if p > 4 {
		p = 4
	}
	_ = duration
	return &p
}

// pollDemo is the demo game's whole tick. It stands in for the fetch +
// applyEvents + applyClock of the live path; everything after is shared.
func (e *Engine) pollDemo(ctx context.Context, g *game, row store.Game, cfg store.Config) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := e.opt.Now()
	g.row = row
	log := e.log.With().
		Int64("match_id", g.matchID).
		Int64("sr_match_id", g.srMatchID).
		Bool("demo", true).
		Logger()

	if g.demo == nil {
		g.demo = &demoState{}
	}
	if !g.demo.loaded {
		if err := e.loadDemoRecording(ctx, g, log); err != nil {
			e.recordError(err)
			log.Error().Err(err).Msg("demo recording load failed")
			return
		}
	}

	epoch := now
	if row.DemoEpoch != nil {
		epoch = *row.DemoEpoch
	}
	phase := demoPhaseAt(epoch, now, g.demo.duration)

	// A wrap is the one moment the demo needs its own handling: the clock
	// is about to go backwards, so anything still open against the cycle
	// that just finished can never settle and is voided. In the ordinary
	// case the cooldown already settled everything and this voids nothing.
	if phase.Index != g.demo.cycleIndex {
		e.voidOpenSpins(ctx, g, voidDemoCycleEnded, now, log)
		g.demo.cycleIndex = phase.Index
		g.lastFrameBody = ""
		log.Info().Int64("cycle", phase.Index).Msg("demo cycle restarted")
	}

	// The events the virtual clock has reached. Sorted, so this is a
	// prefix — an O(len) walk per tick over a few hundred events, which
	// is cheaper than keeping a second index in sync with it.
	g.events = make(map[int64]Event, len(g.demo.recording))
	for i := range g.demo.recording {
		ev := g.demo.recording[i]
		if ev.Seconds > phase.Seconds {
			break
		}
		g.events[ev.ID] = ev
	}
	g.windows = BuildWindows(g.events)
	g.loaded = true

	g.clock = clockFromPhase(phase)
	g.clockAt, g.hasClock = now, true
	e.lastFetchUnix.Store(now.Unix())

	if err := e.st.UpdateGameClock(ctx, store.ClockUpdate{
		MatchID:       g.matchID,
		Seconds:       g.clock.Seconds,
		Running:       g.clock.Running,
		Period:        g.clock.Period,
		ReadAt:        now,
		FeedLagMs:     0,
		CoverageLevel: g.coverage,
		LastEventAt:   nil,
	}); err != nil {
		e.recordError(err)
		log.Error().Err(err).Msg("demo clock update failed")
		return
	}

	// A demo game is a loop, so 'scheduled' and 'ended' are both states it
	// should not be in — the second is reachable (see the note on
	// SelectActiveGames) and would otherwise be permanent. 'paused' and
	// 'voided' are the operator's word and are left alone.
	if g.row.Status == "scheduled" || g.row.Status == "ended" {
		ok, err := e.st.ReviveDemoGame(ctx, g.matchID)
		if err != nil {
			e.recordError(err)
			log.Error().Err(err).Msg("demo revive failed")
			return
		}
		if ok {
			was := g.row.Status
			g.row.Status = "live"
			log.Info().Str("was", was).Msg("demo game live")
		}
	}

	// `ending` stays false for a demo: it is what makes the live path call
	// finishGame, and a demo game must never end. The cooldown carries the
	// same settlement effect through phase.Ended, which WindowFinal reads.
	e.publishState(ctx, g, cfg, now, false, log)
	e.settleSpins(ctx, g, cfg, now, log)
}

func clockFromPhase(p demoPhase) sportradar.Clock {
	return sportradar.Clock{
		Seconds: p.Seconds,
		Running: p.Running,
		Period:  periodFor(p.Seconds, 0),
		Started: true,
		Ended:   p.Ended,
	}
}

// loadDemoRecording fills the in-memory recording, fetching the archived
// timeline once if this deployment has never stored it.
//
// The fetch is the ONLY network call a demo game ever makes, and it is
// made against a finished fixture, so the document is immutable — there
// is nothing to re-poll and no delta to track.
func (e *Engine) loadDemoRecording(ctx context.Context, g *game, log zerolog.Logger) error {
	rows, err := e.st.LoadEvents(ctx, g.srMatchID)
	if err != nil {
		return fmt.Errorf("load demo events: %w", err)
	}
	if len(rows) == 0 {
		if e.client == nil {
			return errors.New("no stored recording and no sportradar client to fetch it")
		}
		log.Info().Msg("demo recording absent; fetching archived timeline once")
		tl, err := e.client.Timeline(ctx, g.srMatchID)
		if err != nil {
			return fmt.Errorf("fetch demo timeline: %w", err)
		}
		// match_id stays NULL, exactly as the calibration corpus stores an
		// archived game: these rows describe a real Sportradar fixture,
		// not the demo stand-in our catalog carries for it.
		if _, err := e.st.UpsertEvents(ctx, nil, tl.Rows()); err != nil {
			return fmt.Errorf("store demo timeline: %w", err)
		}
		rows, err = e.st.LoadEvents(ctx, g.srMatchID)
		if err != nil {
			return fmt.Errorf("reload demo events: %w", err)
		}
	}
	if len(rows) == 0 {
		return errors.New("demo recording is empty after fetch")
	}

	rec := make([]Event, 0, len(rows))
	maxSec := 0
	for _, r := range rows {
		if r.Seconds < 0 {
			continue
		}
		rec = append(rec, Event{
			ID:       r.ID,
			Symbol:   rules.Symbol(r.Symbol),
			Team:     r.Team,
			Seconds:  r.Seconds,
			Disabled: r.Disabled,
			// SeenAt is the corpus row's own timestamp, which is in the
			// past, so the grace period never holds a replayed window
			// open. That is right rather than a shortcut: grace exists to
			// wait for a correction from a live scout, and a finished
			// match has no corrections left to send.
			SeenAt: r.UpdatedAt,
		})
		if r.Seconds > maxSec {
			maxSec = r.Seconds
		}
	}
	// LoadEvents already orders by (seconds, sr_event_id).
	g.demo.recording = rec
	g.demo.duration = maxSec
	if g.demo.duration <= 0 {
		g.demo.duration = demoFallbackDuration
	}
	g.demo.cycle = g.demo.duration + demoCooldownSeconds
	g.demo.loaded = true
	log.Info().
		Int("events", len(rec)).
		Int("duration_seconds", g.demo.duration).
		Int("cycle_seconds", g.demo.cycle).
		Msg("demo recording loaded")
	return nil
}
