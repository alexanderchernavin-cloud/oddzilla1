// Package engine is the per-game state machine: which fixtures the game
// runs on, one Sportradar poll per game per tick, the windows derived
// from the stored events, the public state frame, and the settlement /
// void of open spins on the scout's clock. One Tick per poll interval;
// everything a tick does is idempotent under a crash (the money
// statements in store are apply-once), so a restart re-reads the events
// from Postgres and carries on.

package engine

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"

	"github.com/oddzilla/slotzilla/internal/bus"
	"github.com/oddzilla/slotzilla/internal/rules"
	"github.com/oddzilla/slotzilla/internal/sportradar"
	"github.com/oddzilla/slotzilla/internal/store"
)

const (
	// configTTL is how long the slotzilla_config read is trusted.
	configTTL = 5 * time.Second
	// paytableTTL bounds how stale an edited paytable can be at settlement
	// (the admin route allows editing a table spins already pin).
	paytableTTL = 30 * time.Second
	// stateEvery is the heartbeat cadence of the state frame while a game
	// is live and nothing changed.
	stateEvery = 15 * time.Second
	// neverStartedAfter ends a scheduled game whose fixture never tipped
	// off, so a postponed match is not polled forever.
	neverStartedAfter = 6 * time.Hour

	voidFeedDark       = "feed_dark"
	voidMatchEnded     = "match_ended"
	voidMatchCancelled = "match_cancelled"
	noteNeverStarted   = "never_started"
)

// Options tunes the engine.
type Options struct {
	ReconcileInterval time.Duration
	MaxConcurrent     int
	PollInterval      time.Duration
	// Now is injectable for tests.
	Now func() time.Time
}

type Engine struct {
	st     *store.Store
	client *sportradar.Client
	bus    *bus.Bus
	log    zerolog.Logger
	opt    Options

	mu             sync.Mutex
	cfg            store.Config
	cfgAt          time.Time
	cfgErrAt       time.Time
	disabledLogged bool
	games          map[int64]*game
	paytables      map[int64]cachedPaytable

	tickInFlight  atomic.Bool
	lastFetchUnix atomic.Int64
	lastErrMu     sync.Mutex
	lastErr       string
	lastErrUnix   int64
}

type cachedPaytable struct {
	lines    rules.PaytableLines
	loadedAt time.Time
}

// game is the in-memory state of one running fixture. Its mutex is held
// for the whole of one poll, so a tick never touches a game twice at
// once; the engine's mutex only guards the map of games.
type game struct {
	mu sync.Mutex

	matchID   int64
	srMatchID int64
	row       store.Game

	loaded    bool
	events    map[int64]Event
	windows   map[int]Window
	firstSeen time.Time
	lastOK    time.Time
	lastFull  time.Time

	hasClock bool
	clock    sportradar.Clock
	clockAt  time.Time
	coverage *int

	// demo is non-nil only for a looping recorded fixture; see demo.go.
	demo *demoState

	// ending: the fixture is over (feed or our matches row); the game ends
	// once every open spin has settled or been voided.
	ending bool
	// darkVoided: the feed-dark void already ran for the current outage.
	darkVoided bool
	// sportWarned: the mapping points at a non-basketball fixture.
	sportWarned bool

	lastPublish   time.Time
	lastFrameBody string
}

func New(st *store.Store, client *sportradar.Client, b *bus.Bus, log zerolog.Logger, opt Options) *Engine {
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.MaxConcurrent < 1 {
		opt.MaxConcurrent = 1
	}
	if opt.ReconcileInterval <= 0 {
		opt.ReconcileInterval = time.Minute
	}
	return &Engine{
		st:        st,
		client:    client,
		bus:       b,
		log:       log.With().Str("component", "engine").Logger(),
		opt:       opt,
		games:     map[int64]*game{},
		paytables: map[int64]cachedPaytable{},
	}
}

// Health is what /healthz and the status hash report.
type Health struct {
	Enabled       bool
	Games         int
	LiveGames     int
	LastFetchUnix int64
	LastError     string
	LastErrorUnix int64
}

func (e *Engine) Health() Health {
	e.mu.Lock()
	h := Health{Enabled: e.cfg.Enabled, Games: len(e.games)}
	for _, g := range e.games {
		if g.row.Status == "live" {
			h.LiveGames++
		}
	}
	e.mu.Unlock()
	h.LastFetchUnix = e.lastFetchUnix.Load()
	e.lastErrMu.Lock()
	h.LastError, h.LastErrorUnix = e.lastErr, e.lastErrUnix
	e.lastErrMu.Unlock()
	return h
}

// Tick runs one poll cycle. A tick still running when the next fires is
// skipped rather than overlapped.
func (e *Engine) Tick(ctx context.Context) {
	if !e.tickInFlight.CompareAndSwap(false, true) {
		e.log.Warn().Msg("previous tick still running; skipping")
		return
	}
	defer e.tickInFlight.Store(false)
	now := e.opt.Now()

	cfg, err := e.config(ctx, now)
	if err != nil {
		e.recordError(err)
		e.log.Error().Err(err).Msg("config load failed; keeping the previous settings")
	}
	if !cfg.Enabled {
		e.idle()
		e.writeStatus(ctx, cfg, now)
		return
	}
	e.mu.Lock()
	e.disabledLogged = false
	e.mu.Unlock()

	if err := e.discoverGames(ctx); err != nil {
		e.recordError(err)
		e.log.Error().Err(err).Msg("game discovery failed")
	}
	rows, err := e.st.SelectActiveGames(ctx)
	if err != nil {
		e.recordError(err)
		e.log.Error().Err(err).Msg("select active games failed")
		e.writeStatus(ctx, cfg, now)
		return
	}
	e.syncGames(rows, now)

	sem := make(chan struct{}, e.opt.MaxConcurrent)
	var wg sync.WaitGroup
	for _, row := range rows {
		g := e.gameFor(row.MatchID)
		if g == nil {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(g *game, row store.Game) {
			defer wg.Done()
			defer func() { <-sem }()
			// A demo game replays a stored recording against a virtual
			// clock and never polls the feed; everything below the clock
			// is the same code (see demo.go).
			if row.IsDemo {
				e.pollDemo(ctx, g, row, cfg)
				return
			}
			e.pollGame(ctx, g, row, cfg)
		}(g, row)
	}
	wg.Wait()
	e.writeStatus(ctx, cfg, now)
}

// config returns the operator settings, re-read every configTTL. A read
// error keeps the previous value (logged by the caller).
func (e *Engine) config(ctx context.Context, now time.Time) (store.Config, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.cfgAt.IsZero() && now.Sub(e.cfgAt) < configTTL {
		return e.cfg, nil
	}
	cfg, err := e.st.LoadConfig(ctx)
	if err != nil {
		return e.cfg, err
	}
	e.cfg, e.cfgAt = cfg, now
	return cfg, nil
}

// idle drops in-memory state while the game is switched off. Rows in
// Postgres are untouched: switching back on resumes from them.
func (e *Engine) idle() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.disabledLogged {
		e.log.Warn().Msg("slotzilla_config.enabled is false; idling (switch on at /admin/slotzilla)")
		e.disabledLogged = true
	}
	if len(e.games) > 0 {
		e.games = map[int64]*game{}
	}
}

// discoverGames creates a game row for every eligible fixture that has
// none yet.
func (e *Engine) discoverGames(ctx context.Context) error {
	cands, err := e.st.SelectCandidates(ctx)
	if err != nil {
		return err
	}
	if len(cands) == 0 {
		return nil
	}
	var paytable *int64
	if id, ok, err := e.st.ActivePaytableID(ctx); err != nil {
		return err
	} else if ok {
		paytable = &id
	}
	for _, c := range cands {
		created, err := e.st.InsertGameIfAbsent(ctx, c.MatchID, c.SrMatchID, paytable)
		if err != nil {
			return err
		}
		if created {
			e.log.Info().Int64("match_id", c.MatchID).Int64("sr_match_id", c.SrMatchID).Msg("game scheduled")
		}
	}
	return nil
}

// syncGames aligns the in-memory map with the active rows.
func (e *Engine) syncGames(rows []store.Game, now time.Time) {
	e.mu.Lock()
	defer e.mu.Unlock()
	seen := make(map[int64]struct{}, len(rows))
	for _, r := range rows {
		seen[r.MatchID] = struct{}{}
		if _, ok := e.games[r.MatchID]; !ok {
			e.games[r.MatchID] = &game{matchID: r.MatchID, srMatchID: r.SrMatchID, firstSeen: now, events: map[int64]Event{}}
		}
	}
	for id := range e.games {
		if _, ok := seen[id]; !ok {
			delete(e.games, id)
		}
	}
}

func (e *Engine) gameFor(matchID int64) *game {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.games[matchID]
}

// pollGame is one game's share of a tick.
func (e *Engine) pollGame(ctx context.Context, g *game, row store.Game, cfg store.Config) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := e.opt.Now()
	g.row = row
	log := e.log.With().Int64("match_id", g.matchID).Int64("sr_match_id", g.srMatchID).Logger()

	switch {
	case row.MatchStatus == "cancelled":
		e.voidOpenSpins(ctx, g, voidMatchCancelled, now, log)
		if _, err := e.st.VoidGame(ctx, g.matchID, voidMatchCancelled); err != nil {
			e.recordError(err)
			log.Error().Err(err).Msg("void game failed")
			return
		}
		g.row.Status = "voided"
		e.publishState(ctx, g, cfg, now, true, log)
		log.Warn().Msg("game voided: fixture cancelled")
		return
	case row.MatchStatus == "closed":
		g.ending = true
	case row.Status == "scheduled" && !g.hasClock && now.Sub(row.ScheduledAt) > neverStartedAfter:
		note := noteNeverStarted
		if _, err := e.st.EndGame(ctx, g.matchID, &note); err != nil {
			e.recordError(err)
			log.Error().Err(err).Msg("end game failed")
			return
		}
		log.Warn().Time("scheduled_at", row.ScheduledAt).Msg("game ended: fixture never started")
		return
	}

	if !g.loaded {
		if err := e.loadEvents(ctx, g); err != nil {
			e.recordError(err)
			log.Error().Err(err).Msg("load stored events failed")
			return
		}
	}

	full := g.lastFull.IsZero() || now.Sub(g.lastFull) >= e.opt.ReconcileInterval
	var (
		tl  *sportradar.Timeline
		err error
	)
	if full {
		tl, err = e.client.Timeline(ctx, g.srMatchID)
	} else {
		tl, err = e.client.TimelineDelta(ctx, g.srMatchID)
	}
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		e.recordError(err)
		log.Warn().Err(err).Bool("full", full).Msg("feed fetch failed")
		e.onFeedSilence(ctx, g, cfg, now, log)
		if g.ending {
			e.finishGame(ctx, g, cfg, now, log)
		}
		return
	}
	g.lastOK = now
	if full {
		g.lastFull = now
	}
	e.lastFetchUnix.Store(now.Unix())
	e.onFeedBack(ctx, g, now, log)

	if tl.Match.SportID != sportradar.BasketballSportID && !g.sportWarned {
		log.Warn().Int("sr_sport_id", tl.Match.SportID).Msg("mapped fixture is not basketball; polling anyway")
		g.sportWarned = true
	}

	changed, err := e.applyEvents(ctx, g, tl, now)
	if err != nil {
		e.recordError(err)
		log.Error().Err(err).Msg("upsert events failed")
		return
	}
	if err := e.applyClock(ctx, g, tl, now, log); err != nil {
		e.recordError(err)
		log.Error().Err(err).Msg("clock update failed")
		return
	}
	if changed || g.windows == nil {
		g.windows = BuildWindows(g.events)
	}
	e.publishState(ctx, g, cfg, now, false, log)
	e.settleSpins(ctx, g, cfg, now, log)
	if g.ending {
		e.finishGame(ctx, g, cfg, now, log)
	}
}

// loadEvents seeds the in-memory events from Postgres (a restart, or a
// game first seen with corpus rows already stored).
func (e *Engine) loadEvents(ctx context.Context, g *game) error {
	rows, err := e.st.LoadEvents(ctx, g.srMatchID)
	if err != nil {
		return err
	}
	g.events = make(map[int64]Event, len(rows))
	for _, r := range rows {
		g.events[r.ID] = Event{ID: r.ID, Symbol: rules.Symbol(r.Symbol), Team: r.Team, Seconds: r.Seconds, Disabled: r.Disabled, SeenAt: r.UpdatedAt}
	}
	g.windows = BuildWindows(g.events)
	g.loaded = true
	return nil
}

// applyEvents writes the fetched events and merges them into memory,
// stamping SeenAt only on rows that were new or changed. Reports whether
// any window may have changed.
func (e *Engine) applyEvents(ctx context.Context, g *game, tl *sportradar.Timeline, now time.Time) (bool, error) {
	rows := tl.Rows()
	if len(rows) == 0 {
		return false, nil
	}
	matchID := g.matchID
	changedIDs, err := e.st.UpsertEvents(ctx, &matchID, rows)
	if err != nil {
		return false, err
	}
	changed := make(map[int64]struct{}, len(changedIDs))
	for _, id := range changedIDs {
		changed[id] = struct{}{}
	}
	touched := false
	for _, r := range rows {
		prev, had := g.events[r.SrEventID]
		ev := Event{ID: r.SrEventID, Symbol: rules.Symbol(r.Symbol), Team: r.Team, Seconds: r.Seconds, Disabled: r.Disabled, SeenAt: prev.SeenAt}
		if _, isChanged := changed[r.SrEventID]; isChanged || !had {
			ev.SeenAt = now
			touched = true
		}
		g.events[r.SrEventID] = ev
	}
	return touched, nil
}

// applyClock reads the clock off the match block, writes it to the game
// row and applies the scheduled -> live and -> ending transitions.
func (e *Engine) applyClock(ctx context.Context, g *game, tl *sportradar.Timeline, now time.Time, log zerolog.Logger) error {
	clock := tl.Match.Clock()
	g.clock, g.clockAt, g.hasClock = clock, now, true
	if lvl := tl.Match.CoverageLevel(); lvl != nil {
		g.coverage = lvl
	}
	var lastEventAt *time.Time
	var maxUTS int64
	for i := range tl.Events {
		if tl.Events[i].UTS > maxUTS {
			maxUTS = tl.Events[i].UTS
		}
	}
	if maxUTS > 0 {
		t := time.Unix(maxUTS, 0)
		lastEventAt = &t
	}
	if err := e.st.UpdateGameClock(ctx, store.ClockUpdate{
		MatchID:       g.matchID,
		Seconds:       clock.Seconds,
		Running:       clock.Running,
		Period:        clock.Period,
		ReadAt:        now,
		FeedLagMs:     int(tl.FeedLag(now) / time.Millisecond),
		CoverageLevel: g.coverage,
		LastEventAt:   lastEventAt,
	}); err != nil {
		return err
	}
	if g.row.Status == "scheduled" && clock.Started {
		ok, err := e.st.MarkGameLive(ctx, g.matchID)
		if err != nil {
			return err
		}
		if ok {
			g.row.Status = "live"
			log.Info().Int("clock", clock.Seconds).Msg("game live")
		}
	}
	if clock.Ended && !g.ending {
		g.ending = true
		log.Info().Int("clock", clock.Seconds).Msg("fixture ended; settling what the clock reached")
	}
	return nil
}

// onFeedSilence voids every open spin once the feed has been dark for
// feed_dark_void_seconds and parks a live game as paused (service pause:
// paused_by NULL, note feed_dark).
func (e *Engine) onFeedSilence(ctx context.Context, g *game, cfg store.Config, now time.Time, log zerolog.Logger) {
	if g.darkVoided {
		return
	}
	since := g.lastOK
	if since.IsZero() {
		since = g.firstSeen
	}
	silence := now.Sub(since)
	if silence < time.Duration(cfg.FeedDarkVoidSeconds)*time.Second {
		return
	}
	log.Error().Dur("silence", silence).Msg("feed dark past threshold; voiding open spins")
	e.voidOpenSpins(ctx, g, voidFeedDark, now, log)
	if g.row.Status == "live" {
		ok, err := e.st.PauseGameByService(ctx, g.matchID, store.NoteFeedDark)
		if err != nil {
			e.recordError(err)
			log.Error().Err(err).Msg("feed-dark pause failed")
		} else if ok {
			g.row.Status = "paused"
			note := store.NoteFeedDark
			g.row.Note, g.row.PausedBy = &note, nil
		}
	}
	g.darkVoided = true
	e.publishState(ctx, g, cfg, now, true, log)
}

// onFeedBack lifts a service-made feed-dark pause once the feed answers
// again. An operator's pause (paused_by set) is never touched.
func (e *Engine) onFeedBack(ctx context.Context, g *game, now time.Time, log zerolog.Logger) {
	if !g.darkVoided {
		return
	}
	g.darkVoided = false
	if g.row.Status == "paused" && g.row.PausedBy == nil && g.row.Note != nil && *g.row.Note == store.NoteFeedDark {
		ok, err := e.st.ResumeServicePause(ctx, g.matchID, store.NoteFeedDark)
		if err != nil {
			e.recordError(err)
			log.Error().Err(err).Msg("feed-dark resume failed")
			return
		}
		if ok {
			g.row.Status = "live"
			g.row.Note = nil
			log.Warn().Time("dark_since", g.lastOK).Msg("feed back; game resumed")
		}
	}
}

func (e *Engine) finalRule(cfg store.Config) FinalRule {
	return FinalRule{ClockPastSeconds: cfg.ClockPastSeconds, GraceSeconds: cfg.GraceSeconds}
}

// windowFinal applies the final predicate to one of this game's windows.
func (e *Engine) windowFinal(g *game, from int, cfg store.Config, now time.Time) bool {
	if !g.hasClock {
		return false
	}
	return WindowFinal(WindowAt(g.windows, from), g.clock.Seconds, g.clock.Ended || g.ending, now, e.finalRule(cfg))
}

// publishState sends the slotzilla_state frame when the clock or the
// windows changed, and at least every stateEvery while the game is on.
func (e *Engine) publishState(ctx context.Context, g *game, cfg store.Config, now time.Time, force bool, log zerolog.Logger) {
	frame := stateFrame{Type: "slotzilla_state", MatchID: strconv.FormatInt(g.matchID, 10), Status: g.row.Status, Windows: []windowJSON{}}
	frame.Clock.AtMs = g.clockAt.UnixMilli()
	if g.hasClock {
		frame.Clock.Running = g.clock.Running
		frame.Clock.Period = g.clock.Period
		if g.clock.Started {
			s := g.clock.Seconds
			frame.Clock.Seconds = &s
			for _, w := range RecentWindows(g.windows, g.clock.Seconds) {
				frame.Windows = append(frame.Windows, windowToJSON(w, e.windowFinal(g, w.From, cfg, now)))
			}
		}
	}
	body, err := json.Marshal(frame)
	if err != nil {
		log.Error().Err(err).Msg("marshal state frame")
		return
	}
	// The comparison key excludes ts: a heartbeat is the only reason to
	// resend an identical frame.
	key := string(body)
	if !force && key == g.lastFrameBody && now.Sub(g.lastPublish) < stateEvery {
		return
	}
	frame.Ts = now.UnixMilli()
	out, err := json.Marshal(frame)
	if err != nil {
		log.Error().Err(err).Msg("marshal state frame")
		return
	}
	if err := e.bus.PublishState(ctx, g.matchID, out); err != nil {
		if ctx.Err() == nil {
			e.recordError(err)
			log.Warn().Err(err).Msg("publish state failed")
		}
		return
	}
	g.lastFrameBody, g.lastPublish = key, now
}

// settleSpins settles every open spin whose three windows are final.
func (e *Engine) settleSpins(ctx context.Context, g *game, cfg store.Config, now time.Time, log zerolog.Logger) {
	spins, err := e.st.OpenSpins(ctx, g.matchID)
	if err != nil {
		e.recordError(err)
		log.Error().Err(err).Msg("open spins failed")
		return
	}
	for _, sp := range spins {
		ws := rules.RoundWindowsOf(sp.WindowFrom)
		if !e.windowFinal(g, ws[0], cfg, now) || !e.windowFinal(g, ws[1], cfg, now) || !e.windowFinal(g, ws[2], cfg, now) {
			continue
		}
		lines, err := e.paytable(ctx, sp.PaytableID, now)
		if err != nil {
			e.recordError(err)
			log.Error().Err(err).Str("spin_id", sp.ID).Int64("paytable_id", sp.PaytableID).Msg("paytable load failed; spin stays open")
			continue
		}
		reels := [3]rules.Reel{WindowAt(g.windows, ws[0]).Reel, WindowAt(g.windows, ws[1]).Reel, WindowAt(g.windows, ws[2]).Reel}
		st, err := Outcome(reels, lines, sp.StakeMicro)
		if err != nil {
			e.recordError(err)
			log.Error().Err(err).Str("spin_id", sp.ID).Msg("outcome failed; spin stays open")
			continue
		}
		ok, err := e.st.SettleSpin(ctx, sp, st)
		if err != nil {
			e.recordError(err)
			log.Error().Err(err).Str("spin_id", sp.ID).Msg("settle failed")
			continue
		}
		if !ok {
			continue // voided or settled by another actor meanwhile
		}
		log.Info().Str("spin_id", sp.ID).Str("user_id", sp.UserID).Str("currency", sp.Currency).
			Int("window_from", sp.WindowFrom).Strs("reels", []string{string(st.Reels[0]), string(st.Reels[1]), string(st.Reels[2])}).
			Str("line", st.LineKey).Int("x100", st.MultiplierX100).Int64("stake_micro", sp.StakeMicro).Int64("payout_micro", st.PayoutMicro).
			Str("status", st.Status).Msg("spin settled")
		e.publishSpin(ctx, sp.UserID, SettledSpinView(sp, st, now), now, log)
	}
}

// finishGame runs once the fixture is over: spins whose last window the
// clock never reached are voided (match_ended), the rest settle through
// settleSpins as their grace elapses, and the game ends when none is
// left open.
func (e *Engine) finishGame(ctx context.Context, g *game, cfg store.Config, now time.Time, log zerolog.Logger) {
	spins, err := e.st.OpenSpins(ctx, g.matchID)
	if err != nil {
		e.recordError(err)
		log.Error().Err(err).Msg("open spins failed")
		return
	}
	remaining := 0
	for _, sp := range spins {
		if g.hasClock && g.clock.Seconds >= rules.RoundEnd(sp.WindowFrom) {
			remaining++ // reached; settles once its grace elapses
			continue
		}
		e.voidSpin(ctx, sp, voidMatchEnded, now, log)
	}
	if remaining > 0 {
		return
	}
	ok, err := e.st.EndGame(ctx, g.matchID, nil)
	if err != nil {
		e.recordError(err)
		log.Error().Err(err).Msg("end game failed")
		return
	}
	if ok {
		g.row.Status = "ended"
		e.publishState(ctx, g, cfg, now, true, log)
		log.Info().Msg("game ended")
	}
}

// voidOpenSpins refunds every open spin on the game with one reason.
func (e *Engine) voidOpenSpins(ctx context.Context, g *game, reason string, now time.Time, log zerolog.Logger) {
	spins, err := e.st.OpenSpins(ctx, g.matchID)
	if err != nil {
		e.recordError(err)
		log.Error().Err(err).Msg("open spins failed")
		return
	}
	for _, sp := range spins {
		e.voidSpin(ctx, sp, reason, now, log)
	}
}

func (e *Engine) voidSpin(ctx context.Context, sp store.Spin, reason string, now time.Time, log zerolog.Logger) {
	ok, err := e.st.VoidSpin(ctx, sp, reason)
	if err != nil {
		e.recordError(err)
		log.Error().Err(err).Str("spin_id", sp.ID).Msg("void failed")
		return
	}
	if !ok {
		return
	}
	log.Warn().Str("spin_id", sp.ID).Str("user_id", sp.UserID).Str("currency", sp.Currency).Int64("stake_micro", sp.StakeMicro).
		Int("window_from", sp.WindowFrom).Str("reason", reason).Msg("spin voided")
	e.publishSpin(ctx, sp.UserID, VoidSpinView(sp, reason, now), now, log)
}

func (e *Engine) publishSpin(ctx context.Context, userID string, v SpinView, now time.Time, log zerolog.Logger) {
	body, err := encodeSpinFrame(v, now)
	if err != nil {
		log.Error().Err(err).Msg("marshal spin frame")
		return
	}
	if err := e.bus.PublishSpin(ctx, userID, body); err != nil && ctx.Err() == nil {
		// Best-effort fan-out: the api's poll of the spin is the fallback.
		log.Warn().Err(err).Str("spin_id", v.ID).Msg("publish spin failed")
	}
}

// paytable returns a spin's own paytable, cached for paytableTTL.
func (e *Engine) paytable(ctx context.Context, id int64, now time.Time) (rules.PaytableLines, error) {
	e.mu.Lock()
	if c, ok := e.paytables[id]; ok && now.Sub(c.loadedAt) < paytableTTL {
		e.mu.Unlock()
		return c.lines, nil
	}
	e.mu.Unlock()
	lines, err := e.st.PaytableLines(ctx, id)
	if err != nil {
		return nil, err
	}
	e.mu.Lock()
	e.paytables[id] = cachedPaytable{lines: lines, loadedAt: now}
	e.mu.Unlock()
	return lines, nil
}

// writeStatus refreshes the backoffice hash.
func (e *Engine) writeStatus(ctx context.Context, cfg store.Config, now time.Time) {
	h := e.Health()
	openSpins, err := e.st.CountOpenSpins(ctx)
	if err != nil && ctx.Err() == nil {
		e.log.Debug().Err(err).Msg("count open spins failed")
	}
	fields := map[string]any{
		"updated_unix":    now.Unix(),
		"enabled":         boolInt(cfg.Enabled),
		"games":           h.Games,
		"live_games":      h.LiveGames,
		"open_spins":      openSpins,
		"last_fetch_unix": h.LastFetchUnix,
		"last_error":      h.LastError,
		"last_error_unix": h.LastErrorUnix,
		"poll_ms":         e.opt.PollInterval.Milliseconds(),
	}
	wctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := e.bus.WriteStatus(wctx, fields); err != nil && ctx.Err() == nil {
		e.log.Debug().Err(err).Msg("status hash write failed")
	}
}

func (e *Engine) recordError(err error) {
	if err == nil || errors.Is(err, context.Canceled) {
		return
	}
	e.lastErrMu.Lock()
	e.lastErr = err.Error()
	e.lastErrUnix = e.opt.Now().Unix()
	e.lastErrMu.Unlock()
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
