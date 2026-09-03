// Snapshot ingester: keeps the previous line in memory, diffs each new
// mapper.Snapshot against it and writes only the deltas to Postgres +
// Redis. Full-snapshot semantics (what Fonbet omits is no longer on
// offer) replace Oddin's per-message outcome diff.
//
// Per cycle, for every match in the snapshot:
//   1. create / refresh the matches row (sport → category → tournament →
//      competitors are auto-created and cached),
//   2. apply lifecycle (not_started → live → closed) with the forward-only
//      guard in store.UpdateMatchStatus,
//   3. upsert new / re-statused markets, changed outcomes, deactivate
//      outcomes and markets that vanished,
//   4. XADD one odds.raw entry per changed outcome, publish marketStatus /
//      matchStatus / score frames, append odds_history for price moves.
//
// Safety rails:
//   - a match whose writes fail is dropped from the in-memory state so the
//     next cycle re-asserts it fully (state never runs ahead of Postgres);
//   - a match must be missing from MissingCyclesToClose consecutive
//     snapshots before it is closed / deactivated (Fonbet occasionally
//     drops an event for one tick);
//   - a snapshot that shrank below half of the previous one is rejected as
//     partial data instead of mass-closing the catalog.

package ingest

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/rs/zerolog"

	"github.com/oddzilla/fonbet-ingester/internal/bus"
	"github.com/oddzilla/fonbet-ingester/internal/mapper"
	"github.com/oddzilla/fonbet-ingester/internal/store"
)

const (
	chunkOutcomes = 4000
	chunkStream   = 1000
	chunkDescs    = 300

	// MissingCyclesToClose is how many consecutive snapshots a known match
	// may be absent from before it is treated as gone.
	MissingCyclesToClose = 3
	// shrinkGuardMinMatches / shrinkGuardRatio: reject a snapshot carrying
	// fewer than ratio × previous matches once the catalog is this big.
	shrinkGuardMinMatches = 200
	shrinkGuardRatio      = 0.5
)

// ErrSnapshotShrunk is returned by Apply when the shrink guard trips.
var ErrSnapshotShrunk = errors.New("snapshot rejected: match count collapsed vs previous cycle")

type Ingester struct {
	st  *store.Store
	bus *bus.Bus
	log zerolog.Logger

	matches       map[int64]*matchState     // Fonbet event id → state
	missing       map[int64]int             // event id → consecutive cycles absent
	closed        map[int64]struct{}        // closed while still present in the feed
	sportIDs      map[int]int               // Fonbet root id → sports.id
	categoryIDs   map[string]int            // "<sportDB>:<slug>" → categories.id
	tournamentIDs map[int]int               // Fonbet segment id → tournaments.id
	competitorIDs map[int64]int             // Fonbet team id → competitors.id
	descrDone     map[string]struct{}       // "<pmid>|<variant>" already written
	baseTemplates map[string]map[int]string // lang → pmid → base template

	lastApplied int // match count of the last applied snapshot (shrink guard)
	suspended   bool
}

type matchState struct {
	DBID      int64
	Live      bool
	Team1     string
	Team2     string
	StartTime int64
	ScoreJSON string
	Markets   map[string]*marketState
}

type marketState struct {
	DBID      int64
	PMID      int
	Canonical string
	Status    int16
	Outcomes  map[string]outcomeState
}

type outcomeState struct {
	Odds   string
	Active bool
}

// Stats summarises one Apply.
type Stats struct {
	Matches, NewMatches, ClosedMatches    int
	MarketsUpserted, MarketsDeactivated   int
	OutcomesUpserted, OutcomesDeactivated int
	OddsEvents, HistoryRows, StatusFrames int
	Failed                                int
	Skipped                               map[string]int
}

// cycleOut accumulates everything published / appended after the per-match
// writes so Redis and odds_history see one burst per cycle.
type cycleOut struct {
	oddsEvents []bus.OddsEvent
	history    []store.OddsHistoryRow
	frames     []store.MatchMarketRef
	frameStat  []int16
	pendingDes []store.MarketDescription
}

func New(st *store.Store, b *bus.Bus, log zerolog.Logger) *Ingester {
	return &Ingester{
		st:            st,
		bus:           b,
		log:           log.With().Str("component", "ingest").Logger(),
		matches:       map[int64]*matchState{},
		missing:       map[int64]int{},
		closed:        map[int64]struct{}{},
		sportIDs:      map[int]int{},
		categoryIDs:   map[string]int{},
		tournamentIDs: map[int]int{},
		competitorIDs: map[int64]int{},
		descrDone:     map[string]struct{}{},
		baseTemplates: map[string]map[int]string{},
	}
}

// Bootstrap seeds the in-memory previous snapshot from the database so a
// restart doesn't re-write every unchanged outcome.
func (in *Ingester) Bootstrap(ctx context.Context) error {
	stored, err := store.LoadProviderState(ctx, in.st.Pool())
	if err != nil {
		return err
	}
	markets, outcomes, unpublished := 0, 0, 0
	for _, sm := range stored {
		eventID, err := strconv.ParseInt(strings.TrimPrefix(sm.ProviderURN, store.URNMatch), 10, 64)
		if err != nil {
			continue
		}
		ms := &matchState{
			DBID: sm.ID, Live: sm.Status == "live", Team1: sm.HomeTeam, Team2: sm.AwayTeam,
			StartTime: sm.StartTime, Markets: map[string]*marketState{},
		}
		for _, mk := range sm.Markets {
			mst := &marketState{DBID: mk.ID, PMID: mk.ProviderMarketID, Canonical: mk.Canonical, Status: mk.Status, Outcomes: map[string]outcomeState{}}
			for _, o := range mk.Outcomes {
				st := outcomeState{Odds: o.RawOdds, Active: o.Active}
				if o.Unpublished {
					// odds-publisher never saw this price (stream trimmed
					// or publisher down). Forget the odds so the first
					// cycle re-emits it onto odds.raw; the pg upsert is a
					// 0-row write because raw_odds is unchanged.
					st.Odds = ""
					unpublished++
				}
				mst.Outcomes[o.OutcomeID] = st
				outcomes++
			}
			ms.Markets[strconv.Itoa(mk.ProviderMarketID)+"|"+mk.Canonical] = mst
			markets++
		}
		in.matches[eventID] = ms
	}
	in.log.Info().Int("matches", len(in.matches)).Int("markets", markets).Int("outcomes", outcomes).
		Int("republish", unpublished).Msg("previous state loaded from postgres")
	return nil
}

// WriteStaticDescriptions upserts the catalogue-derived templates for one
// language and remembers the base templates for variant rows.
func (in *Ingester) WriteStaticDescriptions(ctx context.Context, descs []mapper.Description) error {
	if len(descs) == 0 {
		return nil
	}
	rows := make([]store.MarketDescription, 0, len(descs))
	for _, d := range descs {
		if in.baseTemplates[d.Lang] == nil {
			in.baseTemplates[d.Lang] = map[int]string{}
		}
		in.baseTemplates[d.Lang][d.PMID] = d.Name
		rows = append(rows, store.MarketDescription{ProviderMarketID: d.PMID, Variant: d.Variant, Lang: d.Lang, Name: d.Name, Outcomes: d.Outcomes})
	}
	for i := 0; i < len(rows); i += chunkDescs {
		end := min(i+chunkDescs, len(rows))
		if err := store.UpsertDescriptions(ctx, in.st.Pool(), rows[i:end]); err != nil {
			return err
		}
	}
	in.log.Info().Str("lang", descs[0].Lang).Int("markets", len(rows)).Msg("market descriptions written")
	return nil
}

// Suspended reports whether the staleness watchdog has suspended the
// provider catalog and no snapshot has landed since.
func (in *Ingester) Suspended() bool { return in.suspended }

// SuspendAll suspends every active Fonbet market (feed silent / shutdown)
// and marks the in-memory state so the next successful snapshot
// re-activates everything it still carries.
func (in *Ingester) SuspendAll(ctx context.Context, nowMs int64) error {
	refs, outcomes, err := store.SuspendProviderCatalog(ctx, in.st.Pool())
	if err != nil {
		return err
	}
	for _, ms := range in.matches {
		for _, mk := range ms.Markets {
			if mk.Status == 1 {
				mk.Status = -1
			}
			for oid, o := range mk.Outcomes {
				o.Active = false
				o.Odds = ""
				mk.Outcomes[oid] = o
			}
		}
	}
	in.publishStatusFrames(ctx, refs, -1, nowMs)
	in.suspended = true
	in.log.Warn().Int("markets", len(refs)).Int64("outcomes", outcomes).Msg("provider catalog suspended")
	return nil
}

// Apply diffs one snapshot against the previous state and persists it.
func (in *Ingester) Apply(ctx context.Context, snap *mapper.Snapshot, nowMs int64) (Stats, error) {
	stats := Stats{Matches: len(snap.Matches), Skipped: snap.Skipped}
	// Compare against the last snapshot this process applied, not the
	// bootstrapped database state — a narrowed FONBET_ALLOWED_SPORT_IDS or
	// a long outage legitimately shrinks the line versus what pg holds.
	if in.lastApplied >= shrinkGuardMinMatches && float64(len(snap.Matches)) < float64(in.lastApplied)*shrinkGuardRatio {
		return stats, fmt.Errorf("%w (%d → %d)", ErrSnapshotShrunk, in.lastApplied, len(snap.Matches))
	}
	in.lastApplied = len(snap.Matches)

	out := &cycleOut{}
	seen := make(map[int64]struct{}, len(snap.Matches))

	for _, m := range snap.Matches {
		seen[m.EventID] = struct{}{}
		delete(in.missing, m.EventID)
		if _, done := in.closed[m.EventID]; done {
			continue // finished but still listed by Fonbet; nothing to do
		}
		if err := in.applyMatch(ctx, m, nowMs, out, &stats); err != nil {
			// Drop the in-memory state so the next cycle re-asserts the
			// whole match; Postgres stays the source of truth.
			delete(in.matches, m.EventID)
			stats.Failed++
			if ctx.Err() != nil {
				return stats, ctx.Err()
			}
			in.log.Error().Err(err).Int64("event", m.EventID).Msg("match apply failed; state dropped for retry")
		}
	}

	// Matches absent from the line for several cycles in a row.
	for eventID, ms := range in.matches {
		if _, ok := seen[eventID]; ok {
			continue
		}
		in.missing[eventID]++
		if in.missing[eventID] < MissingCyclesToClose {
			continue
		}
		delete(in.missing, eventID)
		if ms.Live {
			if err := in.closeMatch(ctx, eventID, ms, nowMs, &stats); err != nil {
				in.log.Error().Err(err).Int64("event", eventID).Msg("close vanished live match failed")
			}
			continue
		}
		ids := make([]int64, 0, len(ms.Markets))
		for _, mk := range ms.Markets {
			ids = append(ids, mk.DBID)
		}
		refs, err := store.SetMarketsStatus(ctx, in.st.Pool(), ids, 0, nowMs)
		if err != nil {
			in.log.Error().Err(err).Int64("event", eventID).Msg("deactivate vanished match failed")
			continue
		}
		stats.MarketsDeactivated += len(refs)
		out.addFrames(refs, 0)
		delete(in.matches, eventID)
	}
	for eventID := range in.closed {
		if _, ok := seen[eventID]; !ok {
			delete(in.closed, eventID) // Fonbet dropped it; forget it
		}
	}

	in.flush(ctx, out, nowMs, &stats)
	in.suspended = false
	return stats, nil
}

// applyMatch runs every write for one match. Any error leaves Postgres
// possibly ahead of or behind the in-memory state — the caller resets it.
func (in *Ingester) applyMatch(ctx context.Context, m *mapper.Match, nowMs int64, out *cycleOut, stats *Stats) error {
	ms, err := in.ensureMatch(ctx, m, stats)
	if err != nil {
		return err
	}

	// Lifecycle.
	if m.Finished {
		if err := in.closeMatch(ctx, m.EventID, ms, nowMs, stats); err != nil {
			return err
		}
		in.closed[m.EventID] = struct{}{}
		return nil
	}
	if m.Live && !ms.Live {
		changed, err := store.UpdateMatchStatus(ctx, in.st.Pool(), ms.DBID, "live")
		if err != nil {
			return err
		}
		ms.Live = true
		if changed {
			if err := in.bus.PublishMatchStatus(ctx, ms.DBID, "live", nowMs); err != nil {
				in.log.Warn().Err(err).Msg("publish matchStatus")
			}
		}
	}
	if m.Live {
		if payload := buildLiveScore(m, nowMs); payload != nil && stripUpdatedAt(string(payload)) != stripUpdatedAt(ms.ScoreJSON) {
			if err := store.UpdateMatchLiveScore(ctx, in.st.Pool(), ms.DBID, payload); err != nil {
				in.log.Warn().Err(err).Int64("match", ms.DBID).Msg("live score write failed")
			} else {
				ms.ScoreJSON = string(payload)
				if err := in.bus.PublishLiveScore(ctx, ms.DBID, payload); err != nil {
					in.log.Warn().Err(err).Msg("publish score")
				}
			}
		}
	}

	// Markets: new or re-statused → one bulk upsert.
	var upserts []store.MarketUpsert
	for key, mk := range m.Markets {
		ps := ms.Markets[key]
		if ps == nil || ps.Status != mk.Status {
			upserts = append(upserts, store.MarketUpsert{
				ProviderMarketID: mk.PMID, SpecifiersJSON: mk.Specs, SpecifiersHash: mk.Hash, Status: mk.Status, SourceTs: nowMs,
			})
		}
		if mk.Variant != "" {
			out.pendingDes = in.variantDescriptions(mk, out.pendingDes)
		}
	}
	if len(upserts) > 0 {
		results, err := store.UpsertMarketsBulk(ctx, in.st.Pool(), ms.DBID, upserts)
		if err != nil {
			return err
		}
		stats.MarketsUpserted += len(results)
		byKey := make(map[string]store.MarketUpsertResult, len(results))
		for _, r := range results {
			byKey[strconv.Itoa(r.ProviderMarketID)+"|"+hex.EncodeToString(r.SpecifiersHash)] = r
		}
		for key, mk := range m.Markets {
			r, ok := byKey[strconv.Itoa(mk.PMID)+"|"+hex.EncodeToString(mk.Hash)]
			if !ok {
				continue
			}
			ps := ms.Markets[key]
			if ps == nil {
				ps = &marketState{DBID: r.ID, PMID: mk.PMID, Canonical: mk.Canonical, Outcomes: map[string]outcomeState{}}
				ms.Markets[key] = ps
			}
			if r.NewStatus != r.PrevStatus {
				out.addFrames([]store.MatchMarketRef{{MatchID: ms.DBID, MarketID: r.ID}}, r.NewStatus)
			}
			ps.Status = r.NewStatus
		}
	}

	// Outcomes: compute the diff first, write, then commit to memory.
	var outUpserts []store.OutcomeUpsert
	var deactM []int64
	var deactO []string
	var events []bus.OddsEvent
	var history []store.OddsHistoryRow
	type pendingOutcome struct {
		ps  *marketState
		oid string
		st  outcomeState
	}
	var commit []pendingOutcome
	var forget []pendingOutcome
	now := time.UnixMilli(nowMs)
	for key, mk := range m.Markets {
		ps := ms.Markets[key]
		if ps == nil {
			return fmt.Errorf("market %s has no db id after upsert", key)
		}
		for oid, o := range mk.Outcomes {
			prev, had := ps.Outcomes[oid]
			if had && prev.Odds == o.Odds && prev.Active == o.Active {
				continue
			}
			odds := o.Odds
			outUpserts = append(outUpserts, store.OutcomeUpsert{MarketID: ps.DBID, OutcomeID: oid, Name: o.Name, RawOdds: &odds, Active: o.Active, SourceTs: nowMs})
			events = append(events, bus.OddsEvent{
				MarketID: ps.DBID, OutcomeID: oid, ProviderMarketID: mk.PMID, SpecifiersCanonical: mk.Canonical,
				RawOdds: odds, Active: o.Active, MatchID: ms.DBID, SourceTs: nowMs,
			})
			if !had || prev.Odds != o.Odds {
				history = append(history, store.OddsHistoryRow{MarketID: ps.DBID, OutcomeID: oid, RawOdds: &odds, Ts: now})
			}
			commit = append(commit, pendingOutcome{ps, oid, outcomeState{Odds: o.Odds, Active: o.Active}})
		}
		for oid, prev := range ps.Outcomes {
			if _, still := mk.Outcomes[oid]; still {
				continue
			}
			if prev.Active {
				deactM = append(deactM, ps.DBID)
				deactO = append(deactO, oid)
				// odds-publisher needs a price to apply margin to; a
				// deactivation whose last price we no longer hold (boot
				// republish / post-suspend state) is only written to pg.
				if prev.Odds != "" {
					events = append(events, bus.OddsEvent{
						MarketID: ps.DBID, OutcomeID: oid, ProviderMarketID: mk.PMID, SpecifiersCanonical: mk.Canonical,
						RawOdds: prev.Odds, Active: false, MatchID: ms.DBID, SourceTs: nowMs,
					})
				}
			}
			forget = append(forget, pendingOutcome{ps: ps, oid: oid})
		}
	}
	var gone []int64
	var goneKeys []string
	for key, ps := range ms.Markets {
		if _, still := m.Markets[key]; still {
			continue
		}
		gone = append(gone, ps.DBID)
		goneKeys = append(goneKeys, key)
	}

	for i := 0; i < len(outUpserts); i += chunkOutcomes {
		end := min(i+chunkOutcomes, len(outUpserts))
		if err := store.UpsertOutcomesBulk(ctx, in.st.Pool(), outUpserts[i:end]); err != nil {
			return err
		}
	}
	if err := store.DeactivateOutcomes(ctx, in.st.Pool(), deactM, deactO, nowMs); err != nil {
		return err
	}
	if len(gone) > 0 {
		// Markets Fonbet stopped quoting. While the whole event is blocked
		// (goal / VAR pause) they are suspended (-1) so the storefront keeps
		// its "Suspended" rendering; otherwise deactivated (0) — line pulled.
		goneStatus := int16(0)
		if m.Blocked || m.NotActive {
			goneStatus = -1
		}
		refs, err := store.SetMarketsStatus(ctx, in.st.Pool(), gone, goneStatus, nowMs)
		if err != nil {
			return err
		}
		stats.MarketsDeactivated += len(refs)
		out.addFrames(refs, goneStatus)
	}

	// Writes succeeded — commit the diff to memory and queue the fan-out.
	for _, c := range commit {
		c.ps.Outcomes[c.oid] = c.st
	}
	for _, f := range forget {
		delete(f.ps.Outcomes, f.oid)
	}
	for _, key := range goneKeys {
		delete(ms.Markets, key)
	}
	stats.OutcomesUpserted += len(outUpserts)
	stats.OutcomesDeactivated += len(deactM)
	out.oddsEvents = append(out.oddsEvents, events...)
	out.history = append(out.history, history...)
	return nil
}

// flush publishes the cycle's odds events + status frames (best-effort,
// Redis never blocks the loop) and appends odds_history + variant rows.
func (in *Ingester) flush(ctx context.Context, out *cycleOut, nowMs int64, stats *Stats) {
	for i := 0; i < len(out.oddsEvents); i += chunkStream {
		end := min(i+chunkStream, len(out.oddsEvents))
		if err := in.bus.PublishOddsBatch(ctx, out.oddsEvents[i:end]); err != nil {
			in.log.Warn().Err(err).Msg("xadd odds.raw failed")
			break
		}
	}
	stats.OddsEvents = len(out.oddsEvents)
	for i := range out.frames {
		if err := in.bus.PublishMarketStatus(ctx, out.frames[i].MatchID, out.frames[i].MarketID, out.frameStat[i], nowMs); err != nil {
			in.log.Warn().Err(err).Msg("publish marketStatus")
			break
		}
	}
	stats.StatusFrames = len(out.frames)
	for i := 0; i < len(out.history); i += chunkOutcomes {
		end := min(i+chunkOutcomes, len(out.history))
		if err := store.AppendOddsHistoryBulk(ctx, in.st.Pool(), out.history[i:end]); err != nil {
			in.log.Warn().Err(err).Msg("odds_history append failed")
			break
		}
	}
	stats.HistoryRows = len(out.history)
	for i := 0; i < len(out.pendingDes); i += chunkDescs {
		end := min(i+chunkDescs, len(out.pendingDes))
		if err := store.UpsertDescriptions(ctx, in.st.Pool(), out.pendingDes[i:end]); err != nil {
			in.log.Warn().Err(err).Msg("variant descriptions failed")
			for _, d := range out.pendingDes[i:] {
				delete(in.descrDone, strconv.Itoa(d.ProviderMarketID)+"|"+d.Variant) // retry next cycle
			}
			break
		}
	}
}

func (o *cycleOut) addFrames(refs []store.MatchMarketRef, status int16) {
	for _, r := range refs {
		o.frames = append(o.frames, r)
		o.frameStat = append(o.frameStat, status)
	}
}

func (in *Ingester) closeMatch(ctx context.Context, eventID int64, ms *matchState, nowMs int64, stats *Stats) error {
	changed, err := store.UpdateMatchStatus(ctx, in.st.Pool(), ms.DBID, "closed")
	if err != nil {
		return err
	}
	if changed {
		stats.ClosedMatches++
		if err := in.bus.PublishMatchStatus(ctx, ms.DBID, "closed", nowMs); err != nil {
			in.log.Warn().Err(err).Msg("publish matchStatus closed")
		}
	}
	ids := make([]int64, 0, len(ms.Markets))
	for _, mk := range ms.Markets {
		ids = append(ids, mk.DBID)
	}
	refs, err := store.SetMarketsStatus(ctx, in.st.Pool(), ids, 0, nowMs)
	if err != nil {
		return err
	}
	in.publishStatusFrames(ctx, refs, 0, nowMs)
	stats.MarketsDeactivated += len(refs)
	delete(in.matches, eventID)
	return nil
}

func (in *Ingester) publishStatusFrames(ctx context.Context, refs []store.MatchMarketRef, status int16, nowMs int64) {
	for _, r := range refs {
		if err := in.bus.PublishMarketStatus(ctx, r.MatchID, r.MarketID, status, nowMs); err != nil {
			in.log.Warn().Err(err).Msg("publish marketStatus")
			return
		}
	}
}

// ensureMatch resolves the catalog chain and upserts the matches row when
// the match is new or its header data changed.
func (in *Ingester) ensureMatch(ctx context.Context, m *mapper.Match, stats *Stats) (*matchState, error) {
	ms := in.matches[m.EventID]
	if ms != nil && ms.Team1 == m.Team1 && ms.Team2 == m.Team2 && ms.StartTime == m.StartTime {
		return ms, nil
	}
	db := in.st.Pool()
	sportID, ok := in.sportIDs[m.SportID]
	if !ok {
		// Logos come from the line/logos catalogue (ApplyLogos) — the
		// alias-based CDN path 404s for a third of the sports.
		id, err := store.EnsureSport(ctx, db, store.URNSport+strconv.Itoa(m.SportID), m.Sport.Slug, m.Sport.Name, m.Sport.Kind, "")
		if err != nil {
			return nil, err
		}
		in.sportIDs[m.SportID] = id
		sportID = id
	}
	catSlug := mapper.Slugify(m.Category, 60)
	if catSlug == "" {
		catSlug = "other"
	}
	catKey := strconv.Itoa(sportID) + ":" + catSlug
	categoryID, ok := in.categoryIDs[catKey]
	if !ok {
		id, err := store.EnsureCategory(ctx, db, sportID, catSlug, m.Category)
		if err != nil {
			return nil, err
		}
		in.categoryIDs[catKey] = id
		categoryID = id
	}
	tournamentID, ok := in.tournamentIDs[m.SegmentID]
	if !ok {
		slug := mapper.Slugify(m.SegmentName, 80)
		if slug == "" {
			slug = "segment"
		}
		slug += "-" + strconv.Itoa(m.SegmentID)
		name := m.SegmentName
		if name == "" {
			name = "Tournament " + strconv.Itoa(m.SegmentID)
		}
		id, err := store.EnsureTournament(ctx, db, categoryID, store.URNTournament+strconv.Itoa(m.SegmentID), slug, name)
		if err != nil {
			return nil, err
		}
		in.tournamentIDs[m.SegmentID] = id
		tournamentID = id
	}
	home := in.competitor(ctx, sportID, m.Team1ID, m.Team1)
	away := in.competitor(ctx, sportID, m.Team2ID, m.Team2)

	up := store.MatchUpsert{
		TournamentID: tournamentID,
		ProviderURN:  store.URNMatch + strconv.FormatInt(m.EventID, 10),
		HomeTeam:     m.Team1,
		AwayTeam:     m.Team2,
		Status:       "not_started",
	}
	if m.Live {
		up.Status = "live"
	}
	if m.Team1ID != 0 {
		up.HomeTeamURN = sql.NullString{String: store.URNCompetitor + strconv.FormatInt(m.Team1ID, 10), Valid: true}
	}
	if m.Team2ID != 0 {
		up.AwayTeamURN = sql.NullString{String: store.URNCompetitor + strconv.FormatInt(m.Team2ID, 10), Valid: true}
	}
	if home != 0 {
		up.HomeCompetitorID = sql.NullInt32{Int32: int32(home), Valid: true}
	}
	if away != 0 {
		up.AwayCompetitorID = sql.NullInt32{Int32: int32(away), Valid: true}
	}
	if m.StartTime > 0 {
		up.ScheduledAt = sql.NullTime{Time: time.Unix(m.StartTime, 0).UTC(), Valid: true}
	}
	id, err := store.UpsertMatch(ctx, db, up)
	if err != nil {
		return nil, err
	}
	if ms == nil {
		stats.NewMatches++
		ms = &matchState{DBID: id, Live: m.Live, Markets: map[string]*marketState{}}
		in.matches[m.EventID] = ms
	}
	ms.DBID = id
	ms.Team1, ms.Team2, ms.StartTime = m.Team1, m.Team2, m.StartTime
	return ms, nil
}

func (in *Ingester) competitor(ctx context.Context, sportID int, teamID int64, name string) int {
	if teamID == 0 || name == "" {
		return 0
	}
	if id, ok := in.competitorIDs[teamID]; ok {
		return id
	}
	slug := mapper.Slugify(name, 60)
	if slug == "" {
		slug = "team"
	}
	slug += "-" + strconv.FormatInt(teamID, 10)
	id, err := store.EnsureCompetitor(ctx, in.st.Pool(), sportID, store.URNCompetitor+strconv.FormatInt(teamID, 10), slug, name)
	if err != nil {
		in.log.Warn().Err(err).Int64("team", teamID).Msg("competitor upsert failed; match keeps text names")
		return 0
	}
	in.competitorIDs[teamID] = id
	return id
}

// variantDescriptions queues "<sub-event>: <market>" templates for a
// sub-event market the first time it is seen, in every catalogue language.
func (in *Ingester) variantDescriptions(mk *mapper.Market, pending []store.MarketDescription) []store.MarketDescription {
	key := strconv.Itoa(mk.PMID) + "|" + mk.Variant
	if _, done := in.descrDone[key]; done {
		return pending
	}
	in.descrDone[key] = struct{}{}
	for lang, base := range in.baseTemplates {
		tpl, ok := base[mk.PMID]
		if !ok {
			continue
		}
		pending = append(pending, store.MarketDescription{
			ProviderMarketID: mk.PMID, Variant: mk.Variant, Lang: lang,
			Name: mapper.VariantTemplate(mk.VariantLabel, tpl),
		})
	}
	return pending
}

func stripUpdatedAt(s string) string {
	i := strings.Index(s, `,"updatedAt"`)
	if i < 0 {
		return s
	}
	return s[:i]
}
