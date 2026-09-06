// Runner: one Bifrost socket, one subscription per match in the active
// esports offer, plus the global match-state stream. Every frame is
// translated into Oddin-shaped XML and, while the gate says the primary
// feed is down, appended to the `oddin.backup` Redis stream.
//
// Recovery model. Bifrost is state-based, not event-based: every
// subscription opens with a full snapshot (withInit) and every later frame
// is again the complete match. So this service has no cursor, no replay
// request and no "missed message" class of bug — a reconnect, a restart or
// a gate activation simply re-emits the current truth. Settlement follows
// the same principle: a bet_settlement is synthesised whenever a CLOSED
// market on Bifrost is still open in our own database (dbstate), which is
// a comparison of two current states, not a log of what we already sent.

package feed

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"github.com/oddzilla/bifrost-feed/internal/bifrost"
	"github.com/oddzilla/bifrost-feed/internal/config"
	"github.com/oddzilla/bifrost-feed/internal/dbstate"
	"github.com/oddzilla/bifrost-feed/internal/gate"
	"github.com/oddzilla/bifrost-feed/internal/publisher"
	"github.com/oddzilla/bifrost-feed/internal/translate"
)

const (
	stateSubscriptionID = "state"
	matchSubPrefix      = "m:"
	// closedGrace keeps a CLOSED match subscribed long enough for Bifrost
	// to finish flipping its last markets to terminal statuses; per the
	// 2026-09-03 probe settled markets stay visible for two weeks, so ten
	// minutes is about latency, not retention.
	closedGrace = 10 * time.Minute
	// historicSweepWindow bounds the results list every resync scans for
	// settlements the primary never delivered (e.g. a market that closed
	// while both feeds were down).
	historicSweepWindow = 3 * time.Hour
	// wideSweepWindow is the deeper pass run on activation and every
	// wideSweepEvery resyncs: after a multi-hour outage of the whole stack
	// the three-hour pass would miss matches that closed early in the gap.
	// Bifrost keeps settled markets on the historic match for at least two
	// weeks (2026-09-03 probe), so 72 h is well inside what it can answer,
	// and the pass fetches only matches our own DB still holds open — the
	// cost of a wider window is list pages, not detail fetches. It was 24 h
	// until 2026-09-06: the unplayed-map cancels (emitUnplayedMapCancels)
	// ride this pass too, and a day was too short to reach the fixtures
	// that had closed before the cancel path existed — 940 markets on the
	// 09-05 matches were still waiting for a snapshot the 24 h window
	// would never fetch again.
	wideSweepWindow   = 72 * time.Hour
	wideSweepEvery    = 6
	gatePollEvery     = time.Second
	reconnectMax      = 30 * time.Second
	unauthorizedPause = 60 * time.Second
)

type Stats struct {
	Connected      bool      `json:"connected"`
	ConnectedSince time.Time `json:"connectedSince,omitempty"`
	ClientID       int       `json:"clientId,omitempty"`
	ClientName     string    `json:"clientName,omitempty"`
	Reconnects     int64     `json:"reconnects"`
	Tracked        int       `json:"trackedMatches"`
	Frames         int64     `json:"frames"`
	LastFrameAt    time.Time `json:"lastFrameAt,omitempty"`
	OddsChanges    int64     `json:"oddsChangesPublished"`
	Settlements    int64     `json:"settlementsPublished"`
	FixtureChanges int64     `json:"fixtureChangesPublished"`
	SettledMarkets int64     `json:"settledMarketsPublished"`
	// Cancellations / CancelledMarkets count the bet_cancel messages voiced
	// for maps a CLOSED series never reached (translate.UnplayedMapCancels).
	Cancellations    int64     `json:"cancellationsPublished"`
	CancelledMarkets int64     `json:"cancelledMarketsPublished"`
	LastPublishAt    time.Time `json:"lastPublishAt,omitempty"`
	LastError        string    `json:"lastError,omitempty"`
	LastErrorAt      time.Time `json:"lastErrorAt,omitempty"`
	LastResyncAt     time.Time `json:"lastResyncAt,omitempty"`
}

type tracked struct {
	id       string
	urn      string
	state    string
	start    time.Time
	last     *bifrost.Match
	closedAt time.Time
	// settled remembers markets we already voiced this activation so the
	// DB is not re-queried on every frame of a live match. It is only a
	// cache: dbstate remains the authority, and it is reset on activation.
	settled map[bifrost.MarketKey]struct{}
}

type Runner struct {
	cfg    config.Config
	client *bifrost.Client
	pub    publisher.Publisher
	db     dbstate.Source
	gate   *gate.Gate
	log    zerolog.Logger

	mu        sync.Mutex
	tracked   map[string]*tracked
	stats     Stats
	lastGen   uint64
	lastFlush time.Time
	resyncNo  int
}

func New(cfg config.Config, client *bifrost.Client, pub publisher.Publisher, db dbstate.Source, g *gate.Gate, log zerolog.Logger) *Runner {
	return &Runner{
		cfg:     cfg,
		client:  client,
		pub:     pub,
		db:      db,
		gate:    g,
		log:     log.With().Str("component", "runner").Logger(),
		tracked: make(map[string]*tracked),
	}
}

// Stats is a copy for the health endpoint and the status hash.
func (r *Runner) Stats() Stats {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.stats
	s.Tracked = len(r.tracked)
	return s
}

// Run connects, subscribes and processes frames until ctx ends,
// reconnecting with exponential backoff.
func (r *Runner) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := r.runOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		r.setConnected(false, bifrost.ConnectionInfo{})
		if err != nil {
			r.recordError(err)
		}
		wait := backoff
		if bifrost.IsUnauthorized(err) {
			r.log.Error().Err(err).Dur("pause", unauthorizedPause).
				Msg("Bifrost rejected the api key; pausing before retry (check BIFROST_API_KEY)")
			wait = unauthorizedPause
		} else {
			r.log.Warn().Err(err).Dur("backoff", backoff).Msg("bifrost socket closed; reconnecting")
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		backoff *= 2
		if backoff > reconnectMax {
			backoff = reconnectMax
		}
		if err == nil {
			backoff = time.Second
		}
	}
}

func (r *Runner) runOnce(ctx context.Context) error {
	ws, err := bifrost.Dial(ctx, r.cfg.Bifrost.WSURL, r.client, r.log)
	if err != nil {
		return err
	}
	defer ws.Close()
	r.setConnected(true, ws.Info)
	r.log.Info().Int("client_id", ws.Info.Client.ID).Str("client_name", ws.Info.Client.Name).Msg("bifrost socket connected")

	if err := ws.Subscribe(stateSubscriptionID, "onMatchStateChanged", bifrost.SubscriptionMatchState, nil); err != nil {
		return fmt.Errorf("subscribe state stream: %w", err)
	}
	if err := r.resubscribeAll(ctx, ws); err != nil {
		return err
	}

	resync := time.NewTicker(time.Duration(r.cfg.ResyncIntervalSeconds) * time.Second)
	defer resync.Stop()
	gateTick := time.NewTicker(gatePollEvery)
	defer gateTick.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case fr, ok := <-ws.Frames():
			if !ok {
				if werr := ws.Err(); werr != nil {
					return werr
				}
				return errors.New("bifrost socket closed")
			}
			r.handleFrame(ctx, ws, fr)
		case <-resync.C:
			r.resync(ctx, ws)
		case <-gateTick.C:
			r.watchGate(ctx)
		}
	}
}

// resubscribeAll lists the active offer over HTTP and opens one detail
// subscription per match. Matches already tracked from a previous socket
// are re-subscribed too — the subscriptions died with the socket, and the
// init frame we get back is the fresh snapshot we want anyway.
func (r *Runner) resubscribeAll(ctx context.Context, ws *bifrost.WS) error {
	refs, err := r.client.ListMatches(ctx, false, "", "")
	if err != nil {
		return fmt.Errorf("list active offer: %w", err)
	}
	r.mu.Lock()
	for _, ref := range refs {
		if _, ok := r.tracked[ref.ID]; !ok {
			r.tracked[ref.ID] = newTracked(ref)
		}
	}
	ids := make([]string, 0, len(r.tracked))
	for id := range r.tracked {
		ids = append(ids, id)
	}
	r.mu.Unlock()

	sent := 0
	for _, id := range ids {
		if err := ws.Subscribe(matchSubPrefix+id, "onUpdateMatchLive", bifrost.SubscriptionMatchLive, map[string]any{"matchId": id}); err != nil {
			return fmt.Errorf("subscribe match %s: %w", id, err)
		}
		sent++
		if sent%r.cfg.SubscriptionBatch == 0 {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(100 * time.Millisecond):
			}
		}
	}
	r.log.Info().Int("listed", len(refs)).Int("subscribed", sent).Msg("subscribed to active offer")
	return nil
}

func newTracked(ref bifrost.MatchRef) *tracked {
	t := &tracked{id: ref.ID, state: ref.State, settled: make(map[bifrost.MarketKey]struct{})}
	if _, path, err := bifrost.DecodeID(ref.ID); err == nil && len(path) > 0 {
		t.urn = path[0]
	}
	if ts, err := time.Parse(time.RFC3339, ref.DatePlannedStart); err == nil {
		t.start = ts
	}
	if ref.State == bifrost.MatchClosed {
		t.closedAt = time.Now()
	}
	return t
}

func (r *Runner) handleFrame(ctx context.Context, ws *bifrost.WS, fr bifrost.Frame) {
	r.mu.Lock()
	r.stats.Frames++
	r.stats.LastFrameAt = time.Now()
	r.mu.Unlock()

	if fr.ID == stateSubscriptionID {
		r.handleStateFrame(ctx, ws, fr)
		return
	}
	if len(fr.ID) <= len(matchSubPrefix) || fr.ID[:len(matchSubPrefix)] != matchSubPrefix {
		return
	}
	matchID := fr.ID[len(matchSubPrefix):]
	switch fr.Type {
	case "error":
		r.log.Warn().Str("match", matchID).RawJSON("payload", nonEmpty(fr.Payload)).Msg("subscription error; dropping match until next resync")
		r.mu.Lock()
		delete(r.tracked, matchID)
		r.mu.Unlock()
	case "complete":
		r.log.Debug().Str("match", matchID).Msg("subscription completed by server")
		r.mu.Lock()
		delete(r.tracked, matchID)
		r.mu.Unlock()
	case "next":
		var payload struct {
			Data struct {
				Match *bifrost.Match `json:"onUpdateMatchLive"`
			} `json:"data"`
		}
		if err := json.Unmarshal(fr.Payload, &payload); err != nil || payload.Data.Match == nil {
			r.log.Debug().Str("match", matchID).Msg("frame without match payload")
			return
		}
		r.process(ctx, payload.Data.Match)
	}
}

func (r *Runner) handleStateFrame(ctx context.Context, ws *bifrost.WS, fr bifrost.Frame) {
	if fr.Type != "next" {
		r.log.Warn().Str("type", fr.Type).RawJSON("payload", nonEmpty(fr.Payload)).Msg("state stream frame")
		return
	}
	var payload struct {
		Data struct {
			Change *bifrost.MatchStateChange `json:"onMatchStateChanged"`
		} `json:"data"`
	}
	if err := json.Unmarshal(fr.Payload, &payload); err != nil || payload.Data.Change == nil {
		return
	}
	ch := payload.Data.Change
	r.mu.Lock()
	t, known := r.tracked[ch.ID]
	if !known {
		if ch.State == bifrost.MatchClosed {
			r.mu.Unlock()
			return
		}
		t = newTracked(bifrost.MatchRef{ID: ch.ID, State: ch.State, DatePlannedStart: ch.DatePlannedStart})
		r.tracked[ch.ID] = t
		r.mu.Unlock()
		if err := ws.Subscribe(matchSubPrefix+ch.ID, "onUpdateMatchLive", bifrost.SubscriptionMatchLive, map[string]any{"matchId": ch.ID}); err != nil {
			r.recordError(fmt.Errorf("subscribe new match %s: %w", ch.ID, err))
		} else {
			r.log.Info().Str("urn", t.urn).Str("state", ch.State).Msg("new match on the offer; subscribed")
		}
		return
	}
	if ch.State == bifrost.MatchClosed && t.closedAt.IsZero() {
		t.closedAt = time.Now()
	}
	r.mu.Unlock()
	// Start-time changes are also carried by the detail frame; process
	// handles them there so both paths share one comparison.
}

// process is the heart: cache the snapshot, and while active translate +
// publish odds, settlements and reschedules.
func (r *Runner) process(ctx context.Context, m *bifrost.Match) {
	urn := m.URN()
	if urn == "" {
		return
	}
	r.mu.Lock()
	t, ok := r.tracked[m.ID]
	if !ok {
		t = newTracked(bifrost.MatchRef{ID: m.ID, State: m.State, DatePlannedStart: m.DatePlannedStart})
		r.tracked[m.ID] = t
	}
	prevStart := t.start
	t.last = m
	t.state = m.State
	if ts, err := time.Parse(time.RFC3339, m.DatePlannedStart); err == nil {
		t.start = ts
	}
	if m.State == bifrost.MatchClosed && t.closedAt.IsZero() {
		t.closedAt = time.Now()
	}
	settledCache := t.settled
	r.mu.Unlock()

	if !r.gate.Active() {
		return
	}
	now := time.Now().UnixMilli()

	if !prevStart.IsZero() && !t.start.IsZero() && !prevStart.Equal(t.start) {
		if body, err := translate.FixtureChangeDateTime(urn, translate.Product(m.State), now, t.start); err == nil {
			r.publish(ctx, "fixture_change", urn, body)
			r.bump(func(s *Stats) { s.FixtureChanges++ })
		}
	}

	if body, err := translate.OddsChange(m, now); err != nil {
		r.recordError(fmt.Errorf("translate odds %s: %w", urn, err))
	} else if body != nil {
		if r.publish(ctx, "odds_change", urn, body) {
			r.bump(func(s *Stats) { s.OddsChanges++ })
		}
	}

	r.emitSettlements(ctx, m, urn, settledCache, now)
}

// cancelSentinel marks, in a match's settled cache, that the unplayed-map
// cancel pass has run for the CLOSED snapshot. It is not a real market key
// (provider market ids are positive), so it can never collide with one.
var cancelSentinel = bifrost.MarketKey{ProviderMarketID: -1, Specifiers: "unplayed-map-cancels"}

// emitSettlements voices every CLOSED market that Bifrost has fully
// resolved and that our own catalogue still holds open, and — once the
// match itself is CLOSED — voids the markets of any map the series never
// reached (translate.UnplayedMapCancels). The second half exists because
// Bifrost drops unplayed maps from its view rather than settling them, so
// without it a BO5 that ended 3-0 kept every map-4 and map-5 market open
// forever.
func (r *Runner) emitSettlements(ctx context.Context, m *bifrost.Match, urn string, cache map[bifrost.MarketKey]struct{}, now int64) {
	cands := translate.SettleCandidates(m)
	pending := make([]translate.SettleCandidate, 0, len(cands))
	r.mu.Lock()
	for _, c := range cands {
		if _, done := cache[c.Key]; !done {
			pending = append(pending, c)
		}
	}
	_, cancelsDone := cache[cancelSentinel]
	r.mu.Unlock()
	wantCancels := m.State == bifrost.MatchClosed && !cancelsDone
	if len(pending) == 0 && !wantCancels {
		return
	}
	filter, err := r.db.OpenMarkets(ctx, urn)
	if err != nil {
		r.recordError(fmt.Errorf("db open markets %s: %w", urn, err))
		return
	}
	if !filter.Known {
		// We never ingested this match: no market rows, no tickets. Nothing
		// to settle; remember that so a busy live match does not re-query.
		r.mu.Lock()
		for _, c := range pending {
			cache[c.Key] = struct{}{}
		}
		if wantCancels {
			cache[cancelSentinel] = struct{}{}
		}
		r.mu.Unlock()
		return
	}
	emit := make([]translate.SettleCandidate, 0, len(pending))
	for _, c := range pending {
		if filter.Settleable(c.Key) {
			emit = append(emit, c)
		}
	}
	// Markets already terminal in our DB (settled by the primary before
	// it went down, or by an earlier pass) never need voicing again.
	r.mu.Lock()
	for _, c := range pending {
		cache[c.Key] = struct{}{}
	}
	r.mu.Unlock()
	if len(emit) > 0 {
		body, err := translate.BetSettlement(m, emit, now)
		if err != nil {
			r.recordError(fmt.Errorf("translate settlement %s: %w", urn, err))
		} else if r.publish(ctx, "bet_settlement", urn, body) {
			r.bump(func(s *Stats) {
				s.Settlements++
				s.SettledMarkets += int64(len(emit))
			})
			r.log.Info().Str("urn", urn).Int("markets", len(emit)).Str("state", m.State).Msg("settlement synthesised")
		}
	}
	if wantCancels {
		r.emitUnplayedMapCancels(ctx, m, urn, filter, cache, now)
	}
}

// emitUnplayedMapCancels voids our open markets on maps the CLOSED snapshot
// proves were never played. A snapshot that proves nothing (MapsPlayed 0,
// which is what the empty CLOSED live-view frame looks like) emits nothing
// and leaves the sentinel unset, so the results sweep's historic fetch
// gets another go; dbstate keeps the whole thing idempotent — a cancelled
// market leaves the Open set and is never voiced twice.
func (r *Runner) emitUnplayedMapCancels(ctx context.Context, m *bifrost.Match, urn string, filter dbstate.Filter, cache map[bifrost.MarketKey]struct{}, now int64) {
	if translate.MapsPlayed(m) == 0 {
		return
	}
	keys := translate.UnplayedMapCancels(m, filter.Open)
	r.mu.Lock()
	cache[cancelSentinel] = struct{}{}
	r.mu.Unlock()
	if len(keys) == 0 {
		return
	}
	body, err := translate.BetCancel(m, keys, now)
	if err != nil {
		r.recordError(fmt.Errorf("translate cancel %s: %w", urn, err))
		return
	}
	if r.publish(ctx, "bet_cancel", urn, body) {
		r.bump(func(s *Stats) {
			s.Cancellations++
			s.CancelledMarkets += int64(len(keys))
		})
		r.log.Info().Str("urn", urn).Int("markets", len(keys)).Int("maps_played", translate.MapsPlayed(m)).Msg("unplayed-map cancel synthesised")
	}
}

func (r *Runner) publish(ctx context.Context, kind, urn string, body []byte) bool {
	if err := r.pub.Publish(ctx, kind, urn, body); err != nil {
		r.recordError(fmt.Errorf("publish %s %s: %w", kind, urn, err))
		return false
	}
	r.bump(func(s *Stats) { s.LastPublishAt = time.Now() })
	return true
}

// watchGate re-emits every cached snapshot when the gate flips to active,
// so the catalogue feed-ingester's watchdog suspended comes back in one
// pass instead of waiting for each match's next natural update.
func (r *Runner) watchGate(ctx context.Context) {
	active, gen := r.gate.Generation()
	flush := r.gate.FlushMark()
	r.mu.Lock()
	if gen == r.lastGen {
		// No activation flip. But a flush acknowledgement that lands while
		// we are already publishing (feed-ingester's flush outran the 15 s
		// activation ceiling — 76 s measured) has just suspended everything
		// we fed; re-emit so the catalogue comes back.
		if active && !flush.IsZero() && flush.After(r.lastFlush) {
			r.lastFlush = flush
			r.mu.Unlock()
			r.log.Warn().Time("flushed_at", flush).Msg("catalogue flush acknowledged after activation; re-emitting every cached match snapshot")
			r.reemitAll(ctx)
			return
		}
		r.mu.Unlock()
		return
	}
	r.lastGen = gen
	r.lastFlush = flush
	r.mu.Unlock()
	if !active {
		r.log.Warn().Msg("gate inactive; publishing stopped")
		return
	}
	r.log.Warn().Msg("gate active; re-emitting every cached match snapshot")
	r.reemitAll(ctx)
	// Deep settlement pass on every activation: if the primary has been
	// gone a while, the markets that closed during that time are exactly
	// what our DB still holds open.
	r.sweepRecentResults(ctx, wideSweepWindow)
}

// reemitAll pushes the cached snapshot of every tracked match through
// process, resetting the per-activation settlement cache so dbstate is
// consulted afresh. Called on activation and, while active, on every
// resync — the latter bounds how long a catalogue suspended by anything
// else (feed-ingester's alive watchdog firing during a forced-backup
// window, an operator recovery) stays dark for prematch matches whose
// natural update cadence is slow.
func (r *Runner) reemitAll(ctx context.Context) {
	r.mu.Lock()
	snapshots := make([]*bifrost.Match, 0, len(r.tracked))
	for _, t := range r.tracked {
		t.settled = make(map[bifrost.MarketKey]struct{})
		if t.last != nil {
			snapshots = append(snapshots, t.last)
		}
	}
	r.mu.Unlock()
	for _, m := range snapshots {
		if ctx.Err() != nil {
			return
		}
		r.process(ctx, m)
	}
	r.log.Info().Int("snapshots", len(snapshots)).Msg("re-emitted cached match snapshots")
}

// resync is the periodic "recovery": re-list the offer to catch matches
// the state stream never announced, drop matches that closed long ago,
// and sweep recent results for settlements our DB still lacks.
func (r *Runner) resync(ctx context.Context, ws *bifrost.WS) {
	r.bump(func(s *Stats) { s.LastResyncAt = time.Now() })
	refs, err := r.client.ListMatches(ctx, false, "", "")
	if err != nil {
		r.recordError(fmt.Errorf("resync list: %w", err))
		return
	}
	listed := make(map[string]struct{}, len(refs))
	var added []string
	r.mu.Lock()
	for _, ref := range refs {
		listed[ref.ID] = struct{}{}
		if _, ok := r.tracked[ref.ID]; !ok {
			r.tracked[ref.ID] = newTracked(ref)
			added = append(added, ref.ID)
		}
	}
	var dropped []string
	for id, t := range r.tracked {
		_, still := listed[id]
		if !t.closedAt.IsZero() && time.Since(t.closedAt) > closedGrace && !still {
			delete(r.tracked, id)
			dropped = append(dropped, id)
		}
	}
	r.mu.Unlock()
	for _, id := range added {
		if err := ws.Subscribe(matchSubPrefix+id, "onUpdateMatchLive", bifrost.SubscriptionMatchLive, map[string]any{"matchId": id}); err != nil {
			r.recordError(fmt.Errorf("resync subscribe %s: %w", id, err))
		}
	}
	for _, id := range dropped {
		_ = ws.Complete(matchSubPrefix + id)
	}
	if len(added) > 0 || len(dropped) > 0 {
		r.log.Info().Int("added", len(added)).Int("dropped", len(dropped)).Msg("resync adjusted subscriptions")
	}
	if r.gate.Active() {
		r.reemitAll(ctx)
		r.mu.Lock()
		r.resyncNo++
		wide := r.resyncNo%wideSweepEvery == 0
		r.mu.Unlock()
		window := historicSweepWindow
		if wide {
			window = wideSweepWindow
		}
		r.sweepRecentResults(ctx, window)
	}
}

// sweepRecentResults walks the results list for the given window and
// settles anything still open on our side. This is the path that heals a
// market which closed while the backup was in standby and the primary was
// already gone, or while the whole stack was down, and it is idempotent by
// construction (dbstate decides). Only matches our DB still holds open are
// fetched in full, so a wide window costs list pages, not detail fetches.
func (r *Runner) sweepRecentResults(ctx context.Context, window time.Duration) {
	to := time.Now().UTC()
	from := to.Add(-window)
	refs, err := r.client.ListMatches(ctx, true, from.Format(time.RFC3339), to.Format(time.RFC3339))
	if err != nil {
		r.recordError(fmt.Errorf("sweep list: %w", err))
		return
	}
	checked, settled, closed := 0, 0, 0
	for _, ref := range refs {
		if ctx.Err() != nil {
			return
		}
		r.mu.Lock()
		_, tracked := r.tracked[ref.ID]
		r.mu.Unlock()
		if tracked {
			continue // live subscription already covers it
		}
		urn := ""
		if _, path, err := bifrost.DecodeID(ref.ID); err == nil && len(path) > 0 {
			urn = path[0]
		}
		if urn == "" {
			continue
		}
		filter, err := r.db.OpenMarkets(ctx, urn)
		if err != nil {
			r.recordError(fmt.Errorf("sweep db %s: %w", urn, err))
			return
		}
		if !filter.Known || (!filter.AllOpen && len(filter.Open) == 0) {
			continue // nothing open on our side, no fetch needed
		}
		checked++
		m, err := r.client.FetchMatch(ctx, ref.ID)
		if err != nil {
			r.recordError(fmt.Errorf("sweep fetch %s: %w", urn, err))
			return
		}
		if m == nil {
			continue
		}
		before := r.Stats().SettledMarkets
		r.emitSettlements(ctx, m, urn, make(map[bifrost.MarketKey]struct{}), time.Now().UnixMilli())
		if r.Stats().SettledMarkets > before {
			settled++
		}
		// Voice the close too. Settling every market our catalogue holds
		// open would normally let settlement's
		// MarkMatchClosedIfAllMarketsTerminal do this for us, but only if
		// Bifrost still lists every one of those markets; any it has
		// dropped would strand the match at `live`. This match is off the
		// live offer and finished, so the lifecycle signal is safe to send
		// directly and is idempotent (feed-ingester's status guard is
		// forward-only).
		if m.State == bifrost.MatchClosed {
			if body, terr := translate.OddsChange(m, time.Now().UnixMilli()); terr != nil {
				r.recordError(fmt.Errorf("sweep translate close %s: %w", urn, terr))
			} else if body != nil && r.publish(ctx, "odds_change", urn, body) {
				r.bump(func(s *Stats) { s.OddsChanges++ })
				closed++
			}
		}
	}
	if checked > 0 {
		r.log.Info().Dur("window", window).Int("results_listed", len(refs)).Int("fetched", checked).Int("matches_settled", settled).Int("matches_closed", closed).Msg("results settlement sweep")
	}
}

func (r *Runner) setConnected(connected bool, info bifrost.ConnectionInfo) {
	r.mu.Lock()
	defer r.mu.Unlock()
	wasConnected := r.stats.Connected
	r.stats.Connected = connected
	if connected {
		r.stats.ConnectedSince = time.Now()
		r.stats.ClientID = info.Client.ID
		r.stats.ClientName = info.Client.Name
		if wasConnected {
			return
		}
		if r.stats.Frames > 0 {
			r.stats.Reconnects++
		}
	}
}

func (r *Runner) recordError(err error) {
	if err == nil {
		return
	}
	r.mu.Lock()
	r.stats.LastError = err.Error()
	r.stats.LastErrorAt = time.Now()
	r.mu.Unlock()
	r.log.Warn().Err(err).Msg("runner error")
}

func (r *Runner) bump(f func(*Stats)) {
	r.mu.Lock()
	f(&r.stats)
	r.mu.Unlock()
}

func nonEmpty(b []byte) []byte {
	if len(b) == 0 {
		return []byte("null")
	}
	return b
}
