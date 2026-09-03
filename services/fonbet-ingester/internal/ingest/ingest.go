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
// Matches missing from the snapshot are closed (if they were live) or get
// their markets deactivated (prematch pulled).

package ingest

import (
	"context"
	"database/sql"
	"encoding/hex"
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
)

type Ingester struct {
	st  *store.Store
	bus *bus.Bus
	log zerolog.Logger

	matches       map[int64]*matchState     // Fonbet event id → state
	sportIDs      map[int]int               // Fonbet root id → sports.id
	categoryIDs   map[string]int            // "<sportDB>:<slug>" → categories.id
	tournamentIDs map[int]int               // Fonbet segment id → tournaments.id
	competitorIDs map[int64]int             // Fonbet team id → competitors.id
	descrDone     map[string]struct{}       // "<pmid>|<variant>" already written
	baseTemplates map[string]map[int]string // lang → pmid → base template

	suspended bool
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
	Skipped                               map[string]int
}

func New(st *store.Store, b *bus.Bus, log zerolog.Logger) *Ingester {
	return &Ingester{
		st:            st,
		bus:           b,
		log:           log.With().Str("component", "ingest").Logger(),
		matches:       map[int64]*matchState{},
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
	markets, outcomes := 0, 0
	for _, sm := range stored {
		eventID, err := strconv.ParseInt(strings.TrimPrefix(sm.ProviderURN, store.URNMatch), 10, 64)
		if err != nil {
			continue
		}
		ms := &matchState{DBID: sm.ID, Live: sm.Status == "live", Team1: sm.HomeTeam, Team2: sm.AwayTeam, Markets: map[string]*marketState{}}
		for _, mk := range sm.Markets {
			mst := &marketState{DBID: mk.ID, PMID: mk.ProviderMarketID, Canonical: mk.Canonical, Status: mk.Status, Outcomes: map[string]outcomeState{}}
			for _, o := range mk.Outcomes {
				mst.Outcomes[o.OutcomeID] = outcomeState{Odds: o.RawOdds, Active: o.Active}
				outcomes++
			}
			ms.Markets[strconv.Itoa(mk.ProviderMarketID)+"|"+mk.Canonical] = mst
			markets++
		}
		in.matches[eventID] = ms
	}
	in.log.Info().Int("matches", len(in.matches)).Int("markets", markets).Int("outcomes", outcomes).Msg("previous state loaded from postgres")
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
	now := time.UnixMilli(nowMs)
	var (
		oddsEvents []bus.OddsEvent
		history    []store.OddsHistoryRow
		frames     []store.MatchMarketRef
		frameStat  []int16
		pendingDes []store.MarketDescription
	)
	seen := make(map[int64]struct{}, len(snap.Matches))

	for _, m := range snap.Matches {
		seen[m.EventID] = struct{}{}
		ms, err := in.ensureMatch(ctx, m, &stats)
		if err != nil {
			in.log.Error().Err(err).Int64("event", m.EventID).Msg("match upsert failed; skipping this cycle")
			continue
		}

		// Lifecycle.
		if m.Finished {
			if err := in.closeMatch(ctx, m.EventID, ms, nowMs, &stats); err != nil {
				in.log.Error().Err(err).Int64("event", m.EventID).Msg("close match failed")
			}
			continue
		}
		if m.Live && !ms.Live {
			changed, err := store.UpdateMatchStatus(ctx, in.st.Pool(), ms.DBID, "live")
			if err != nil {
				in.log.Error().Err(err).Int64("match", ms.DBID).Msg("match → live failed")
			} else {
				ms.Live = true
				if changed {
					if err := in.bus.PublishMatchStatus(ctx, ms.DBID, "live", nowMs); err != nil {
						in.log.Warn().Err(err).Msg("publish matchStatus")
					}
				}
			}
		}
		if m.Live {
			if payload := buildLiveScore(m, nowMs); payload != nil && string(payload) != ms.ScoreJSON {
				// Compare without the timestamp so an unchanged score is a no-op.
				if stripUpdatedAt(string(payload)) != stripUpdatedAt(ms.ScoreJSON) {
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
		}

		// Markets: new or re-statused.
		var upserts []store.MarketUpsert
		for key, mk := range m.Markets {
			ps := ms.Markets[key]
			if ps == nil || ps.Status != mk.Status {
				upserts = append(upserts, store.MarketUpsert{
					ProviderMarketID: mk.PMID, SpecifiersJSON: mk.Specs, SpecifiersHash: mk.Hash, Status: mk.Status, SourceTs: nowMs,
				})
			}
			if mk.Variant != "" {
				pendingDes = in.variantDescriptions(mk, pendingDes)
			}
		}
		if len(upserts) > 0 {
			results, err := store.UpsertMarketsBulk(ctx, in.st.Pool(), ms.DBID, upserts)
			if err != nil {
				in.log.Error().Err(err).Int64("match", ms.DBID).Msg("markets upsert failed; skipping match this cycle")
				continue
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
					frames = append(frames, store.MatchMarketRef{MatchID: ms.DBID, MarketID: r.ID})
					frameStat = append(frameStat, r.NewStatus)
				}
				ps.Status = r.NewStatus
			}
		}

		// Outcomes: changed / new / vanished.
		var outUpserts []store.OutcomeUpsert
		var deactM []int64
		var deactO []string
		for key, mk := range m.Markets {
			ps := ms.Markets[key]
			if ps == nil {
				continue // upsert failed above
			}
			for oid, o := range mk.Outcomes {
				prev, had := ps.Outcomes[oid]
				if had && prev.Odds == o.Odds && prev.Active == o.Active {
					continue
				}
				odds := o.Odds
				outUpserts = append(outUpserts, store.OutcomeUpsert{MarketID: ps.DBID, OutcomeID: oid, Name: o.Name, RawOdds: &odds, Active: o.Active, SourceTs: nowMs})
				oddsEvents = append(oddsEvents, bus.OddsEvent{
					MarketID: ps.DBID, OutcomeID: oid, ProviderMarketID: mk.PMID, SpecifiersCanonical: mk.Canonical,
					RawOdds: odds, Active: o.Active, MatchID: ms.DBID, SourceTs: nowMs,
				})
				if !had || prev.Odds != o.Odds {
					history = append(history, store.OddsHistoryRow{MarketID: ps.DBID, OutcomeID: oid, RawOdds: &odds, Ts: now})
				}
				ps.Outcomes[oid] = outcomeState{Odds: o.Odds, Active: o.Active}
			}
			for oid, prev := range ps.Outcomes {
				if _, still := mk.Outcomes[oid]; still {
					continue
				}
				if prev.Active {
					deactM = append(deactM, ps.DBID)
					deactO = append(deactO, oid)
					oddsEvents = append(oddsEvents, bus.OddsEvent{
						MarketID: ps.DBID, OutcomeID: oid, ProviderMarketID: mk.PMID, SpecifiersCanonical: mk.Canonical,
						RawOdds: prev.Odds, Active: false, MatchID: ms.DBID, SourceTs: nowMs,
					})
				}
				delete(ps.Outcomes, oid)
			}
		}
		var gone []int64
		for key, ps := range ms.Markets {
			if _, still := m.Markets[key]; still {
				continue
			}
			gone = append(gone, ps.DBID)
			delete(ms.Markets, key)
		}

		for i := 0; i < len(outUpserts); i += chunkOutcomes {
			end := min(i+chunkOutcomes, len(outUpserts))
			if err := store.UpsertOutcomesBulk(ctx, in.st.Pool(), outUpserts[i:end]); err != nil {
				return stats, fmt.Errorf("match %d: %w", ms.DBID, err)
			}
		}
		stats.OutcomesUpserted += len(outUpserts)
		if err := store.DeactivateOutcomes(ctx, in.st.Pool(), deactM, deactO, nowMs); err != nil {
			return stats, fmt.Errorf("match %d: %w", ms.DBID, err)
		}
		stats.OutcomesDeactivated += len(deactM)
		if len(gone) > 0 {
			// Markets Fonbet stopped quoting. When the whole event is
			// blocked (goal / VAR pause) they are suspended (-1) so the
			// storefront keeps its "Suspended" rendering; otherwise they
			// are deactivated (0) — the line was pulled.
			goneStatus := int16(0)
			if m.Blocked || m.NotActive {
				goneStatus = -1
			}
			refs, err := store.SetMarketsStatus(ctx, in.st.Pool(), gone, goneStatus, nowMs)
			if err != nil {
				return stats, fmt.Errorf("match %d: %w", ms.DBID, err)
			}
			stats.MarketsDeactivated += len(refs)
			for _, r := range refs {
				frames = append(frames, r)
				frameStat = append(frameStat, goneStatus)
			}
		}
	}

	// Matches that vanished from the line.
	for eventID, ms := range in.matches {
		if _, ok := seen[eventID]; ok {
			continue
		}
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
		for _, r := range refs {
			frames = append(frames, r)
			frameStat = append(frameStat, 0)
		}
		delete(in.matches, eventID)
	}

	// Publish + history. Redis is best-effort (never block on it).
	for i := 0; i < len(oddsEvents); i += chunkStream {
		end := min(i+chunkStream, len(oddsEvents))
		if err := in.bus.PublishOddsBatch(ctx, oddsEvents[i:end]); err != nil {
			in.log.Warn().Err(err).Msg("xadd odds.raw failed")
			break
		}
	}
	stats.OddsEvents = len(oddsEvents)
	for i := range frames {
		if err := in.bus.PublishMarketStatus(ctx, frames[i].MatchID, frames[i].MarketID, frameStat[i], nowMs); err != nil {
			in.log.Warn().Err(err).Msg("publish marketStatus")
			break
		}
	}
	stats.StatusFrames = len(frames)
	for i := 0; i < len(history); i += chunkOutcomes {
		end := min(i+chunkOutcomes, len(history))
		if err := store.AppendOddsHistoryBulk(ctx, in.st.Pool(), history[i:end]); err != nil {
			in.log.Warn().Err(err).Msg("odds_history append failed")
			break
		}
	}
	stats.HistoryRows = len(history)
	for i := 0; i < len(pendingDes); i += chunkDescs {
		end := min(i+chunkDescs, len(pendingDes))
		if err := store.UpsertDescriptions(ctx, in.st.Pool(), pendingDes[i:end]); err != nil {
			in.log.Warn().Err(err).Msg("variant descriptions failed")
			// Forget them so the next cycle retries.
			for _, d := range pendingDes[i:] {
				delete(in.descrDone, strconv.Itoa(d.ProviderMarketID)+"|"+d.Variant)
			}
			break
		}
	}
	in.suspended = false
	return stats, nil
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
		id, err := store.EnsureSport(ctx, db, store.URNSport+strconv.Itoa(m.SportID), m.Sport.Slug, m.Sport.Name, m.Sport.Kind)
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
