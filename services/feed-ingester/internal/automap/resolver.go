// Auto-mapping: turn Oddin provider URNs into local DB ids.
//
// Strategy: when a match URN we've never seen arrives on the AMQP feed,
// fetch the full hierarchy from Oddin's REST endpoint
//   GET /v1/sports/{lang}/sport_events/{matchURN}/fixture
// which returns sport + tournament + competitors + scheduled_at in one
// shot. We then upsert sport → category → tournament → match in order so
// the foreign keys are always satisfied.
//
// Failure handling: if the REST call errors (404 / network / 5xx) we fall
// back to creating a placeholder tournament under the configured fallback
// sport's auto category so the feed never stalls. The mapping_review_queue
// row is flagged so admins can rename later.
//
// Concurrency: many odds_change messages can arrive for the same new match
// before the first INSERT commits. We rely on UPSERT semantics — duplicate
// REST calls are wasteful but never produce incorrect data.

package automap

import (
	"context"
	"database/sql"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/rs/zerolog"

	"github.com/oddzilla/feed-ingester/internal/oddinrest"
	"github.com/oddzilla/feed-ingester/internal/oddinxml"
	"github.com/oddzilla/feed-ingester/internal/store"
)

// REST language code for description endpoints. English is the only one
// our schema is set up for.
const restLang = "en"

// ErrSportBlocked is returned by ResolveMatch when a NEW match maps to a
// sport on the configured blocklist. Callers should ack the AMQP message
// and drop it — no DB rows are written. Existing matches are grandfathered
// in (the filter only applies on first sight).
var ErrSportBlocked = errors.New("sport is on blocklist")

type Resolver struct {
	st  *store.Store
	rc  *oddinrest.Client // may be nil → fallback-only mode
	log zerolog.Logger

	defaultSportID    int
	defaultCategoryID int

	// blockedSportSlugs drops feed messages whose sport abbreviation
	// slugifies into one of these values. nil = no filter. Set from
	// config.OddinConfig.BlockedSportSlugs. Matching by slug (not URN)
	// lets us add a blocklist entry without knowing Oddin's internal
	// sport id ahead of time.
	blockedSportSlugs map[string]struct{}
}

// New builds a Resolver. `rc` may be nil — in that case we never call REST
// and every unknown match becomes a placeholder under the fallback
// sport/category. `blockedSportSlugs` may be nil to disable sport filtering.
func New(
	st *store.Store,
	rc *oddinrest.Client,
	log zerolog.Logger,
	fallbackSportID, fallbackCategoryID int,
	blockedSportSlugs map[string]struct{},
) *Resolver {
	return &Resolver{
		st:                st,
		rc:                rc,
		log:               log,
		defaultSportID:    fallbackSportID,
		defaultCategoryID: fallbackCategoryID,
		blockedSportSlugs: blockedSportSlugs,
	}
}

// sportBlocked returns true when the given Oddin FixtureSport should be
// dropped. An empty blocklist (nil map) permits everything. Matching uses
// slugify(abbreviation) to line up with how resolveSport names auto-created
// rows; empty abbreviations fall back to slugify(name).
func (r *Resolver) sportBlocked(fs oddinxml.FixtureSport) bool {
	if r.blockedSportSlugs == nil {
		return false
	}
	slug := slugify(fs.Abbr)
	if slug == "" {
		slug = slugify(fs.Name)
	}
	if slug == "" {
		return false
	}
	_, ok := r.blockedSportSlugs[slug]
	return ok
}

// MatchContext describes what we know about a match from an inbound XML
// message. Most fields are optional; ResolveMatch fills in missing pieces
// from REST when it has to create the match for the first time.
type MatchContext struct {
	MatchURN        string
	TournamentURN   string // may be empty on some messages
	HomeTeam        string
	AwayTeam        string
	HomeTeamURN     string
	AwayTeamURN     string
	ScheduledAt     time.Time // zero = unknown
	Status          string    // normalized: not_started|live|closed|cancelled|suspended
	OddinStatusCode int16
	BestOf          int16
}

// ResolveMatch returns the matches.id for the supplied URN, creating sport,
// category, tournament, competitor, and match rows on first sight (using
// REST data when possible, falling back to placeholders when not).
func (r *Resolver) ResolveMatch(ctx context.Context, reqCtx MatchContext, rawPayload []byte) (int64, error) {
	if existing, ok, err := store.FindMatchByURN(ctx, r.st.Pool(), reqCtx.MatchURN); err != nil {
		return 0, err
	} else if ok {
		return existing, nil
	}

	// Unknown match — fetch the full hierarchy from REST.
	fixture, fetchErr := r.fetchFixture(ctx, reqCtx.MatchURN)
	if fetchErr != nil {
		r.log.Warn().
			Err(fetchErr).
			Str("match_urn", reqCtx.MatchURN).
			Msg("fixture lookup failed; using fallback placeholder")
	}

	// Sport blocklist gate. Apply as soon as we have authoritative sport
	// data from REST; this prevents bot/test sports (efootballbots,
	// ebasketballbots, …) from ever creating sport/category/tournament/
	// match/market rows. When the REST call failed we can't tell what
	// sport the match belongs to, so we pass it through — the fallback
	// placeholder lives under `unclassified` where it's harmless, and
	// the admin mapping review flow will surface it for triage.
	if r.blockedSportSlugs != nil && fixture != nil {
		fs := fixture.Fixture.Tournament.Sport
		if r.sportBlocked(fs) {
			r.log.Debug().
				Str("match_urn", reqCtx.MatchURN).
				Str("sport_urn", fs.ID).
				Str("sport_name", fs.Name).
				Msg("dropping: sport on blocklist")
			return 0, ErrSportBlocked
		}
	}

	// Merge fixture data into the context (fixture wins where both have a
	// value, since REST is authoritative). When fixture is nil we fall
	// through with whatever the message gave us.
	merged := r.merge(reqCtx, fixture)

	tournamentID, sportID, err := r.resolveTournament(ctx, merged.TournamentURN, fixture, rawPayload)
	if err != nil {
		return 0, err
	}

	homeCompID, awayCompID := r.resolveMatchCompetitors(ctx, sportID, merged)

	mu := r.matchUpsert(merged, tournamentID, homeCompID, awayCompID)
	id, err := store.UpsertMatch(ctx, r.st.Pool(), mu)
	if err != nil {
		return 0, fmt.Errorf("upsert match: %w", err)
	}

	// Enqueue for admin review so an operator can rename or re-categorise
	// any auto-created entity. raw_payload is jsonb, so we wrap the raw
	// XML body inside a JSON envelope rather than dumping it directly.
	matchReview, _ := json.Marshal(map[string]any{
		"provider_urn":   reqCtx.MatchURN,
		"tournament_urn": merged.TournamentURN,
		"home_team":      merged.HomeTeam,
		"away_team":      merged.AwayTeam,
		"scheduled_at":   nullableTimeISO(merged.ScheduledAt),
		"raw_preview":    truncate(string(rawPayload), 1024),
	})
	if err := store.EnqueueReview(ctx, r.st.Pool(), store.ReviewEntry{
		EntityType:      "match",
		Provider:        "oddin",
		ProviderURN:     reqCtx.MatchURN,
		RawPayload:      matchReview,
		CreatedEntityID: fmt.Sprintf("%d", id),
	}); err != nil {
		return 0, fmt.Errorf("enqueue review (match): %w", err)
	}

	// Fetch + cache the competitor profiles (team metadata + player
	// roster) for both sides so player-prop outcomes can be rendered
	// with real names. Errors are non-fatal — the match is already
	// persisted, and outcomes just fall back to raw URNs until the
	// next refresh. Skip URNs we've already cached to avoid wasting
	// REST quota on every re-fetch.
	r.CacheCompetitorProfile(ctx, merged.HomeTeamURN)
	r.CacheCompetitorProfile(ctx, merged.AwayTeamURN)

	return id, nil
}

// CacheCompetitorProfile pulls a competitor's profile (name + roster)
// from REST and upserts competitor_profiles + player_profiles. Best-
// effort: logs warnings but never returns errors, since missing names
// only affect outcome labels and the rest of the ingest must proceed.
func (r *Resolver) CacheCompetitorProfile(ctx context.Context, urn string) {
	if urn == "" || r.rc == nil {
		return
	}
	if exists, err := store.CompetitorProfileExists(ctx, r.st.Pool(), urn); err == nil && exists {
		return
	}
	body, err := r.rc.CompetitorProfile(ctx, restLang, urn)
	if err != nil {
		r.log.Debug().Err(err).Str("competitor_urn", urn).Msg("competitor profile fetch failed")
		return
	}
	var p oddinxml.CompetitorProfile
	if err := xml.Unmarshal(body, &p); err != nil {
		r.log.Debug().Err(err).Str("competitor_urn", urn).Msg("competitor profile unmarshal failed")
		return
	}
	if p.Competitor.ID == "" {
		return
	}
	if err := store.UpsertCompetitorProfile(ctx, r.st.Pool(), &p); err != nil {
		r.log.Warn().Err(err).Str("competitor_urn", urn).Msg("competitor profile upsert failed")
		return
	}
	r.log.Debug().
		Str("competitor_urn", urn).
		Str("name", p.Competitor.Name).
		Int("players", len(p.Players)).
		Msg("competitor profile cached")
}

// refreshTournamentMetadata pulls /v1/sports/{lang}/tournaments/{urn}/info
// and writes the returned risk_tier back to the tournaments row. Best-
// effort: any failure (missing REST client, empty URN, network error,
// malformed response, missing attribute) is logged at debug and the
// write is skipped. Called on tournament creation and on every
// fixture_change refresh, plus from the offline backfill tool.
func (r *Resolver) refreshTournamentMetadata(ctx context.Context, tournamentID int, tournamentURN string) {
	if r.rc == nil || tournamentURN == "" {
		return
	}
	body, err := r.rc.TournamentInfo(ctx, restLang, tournamentURN)
	if err != nil {
		r.log.Debug().Err(err).Str("tournament_urn", tournamentURN).Msg("tournament info fetch failed")
		return
	}
	var info oddinxml.TournamentInfoResponse
	if err := xml.Unmarshal(body, &info); err != nil {
		r.log.Debug().Err(err).Str("tournament_urn", tournamentURN).Msg("tournament info unmarshal failed")
		return
	}
	rt := atoi16(info.Tournament.RiskTier)
	if rt <= 0 {
		return
	}
	if err := store.UpdateTournamentRiskTier(ctx, r.st.Pool(), tournamentID, rt); err != nil {
		r.log.Warn().Err(err).Int("tournament_id", tournamentID).Int16("risk_tier", rt).Msg("tournament risk_tier update failed")
		return
	}
	r.log.Debug().
		Int("tournament_id", tournamentID).
		Str("tournament_urn", tournamentURN).
		Int16("risk_tier", rt).
		Msg("tournament risk_tier updated")
}

// BackfillTournamentRiskTier walks every active tournament with a NULL
// risk_tier, calls the Oddin tournament-info endpoint, and writes the
// returned tier back. Intended to run once after the migration lands;
// new tournaments get their tier through refreshTournamentMetadata on
// auto-mapping. Pace is 5 requests/sec, well under Oddin's tier-3
// budget. Returns the number of rows successfully updated.
func (r *Resolver) BackfillTournamentRiskTier(ctx context.Context) (int, error) {
	if r.rc == nil {
		return 0, errors.New("oddin rest client not configured")
	}
	refs, err := store.TournamentsMissingRiskTier(ctx, r.st.Pool())
	if err != nil {
		return 0, err
	}
	updated := 0
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for _, ref := range refs {
		select {
		case <-ctx.Done():
			return updated, ctx.Err()
		case <-ticker.C:
		}
		body, err := r.rc.TournamentInfo(ctx, restLang, ref.ProviderURN)
		if err != nil {
			r.log.Debug().Err(err).Str("tournament_urn", ref.ProviderURN).Msg("backfill: fetch failed")
			continue
		}
		var info oddinxml.TournamentInfoResponse
		if err := xml.Unmarshal(body, &info); err != nil {
			r.log.Debug().Err(err).Str("tournament_urn", ref.ProviderURN).Msg("backfill: unmarshal failed")
			continue
		}
		rt := atoi16(info.Tournament.RiskTier)
		if rt <= 0 {
			continue
		}
		if err := store.UpdateTournamentRiskTier(ctx, r.st.Pool(), ref.ID, rt); err != nil {
			r.log.Warn().Err(err).Int("tournament_id", ref.ID).Msg("backfill: update failed")
			continue
		}
		updated++
	}
	r.log.Info().Int("considered", len(refs)).Int("updated", updated).Msg("risk_tier backfill complete")
	return updated, nil
}

// DrainPhantomLive walks every match still flagged `live` more than
// `ageHours` after its scheduled start and re-pulls the fixture from
// Oddin REST. Used after a feed-ingester / postgres outage where we
// missed match_status_change messages: the affected rows stay stuck
// at status='live' with zero active markets, which makes them invisible
// on every list endpoint that filters via the active-markets EXISTS
// clause. RefreshFromFixture overwrites matches.status with whatever
// the fixture reports, so closed/ended matches drop out cleanly.
//
// Pace is 5 requests/sec, matching the risk_tier backfill. Returns
// the number of URNs successfully refreshed (REST 404s and other
// best-effort failures are skipped).
func (r *Resolver) DrainPhantomLive(ctx context.Context, ageHours int) (int, error) {
	if r.rc == nil {
		return 0, errors.New("oddin rest client not configured")
	}
	urns, err := store.PhantomLiveMatchURNs(ctx, r.st.Pool(), ageHours)
	if err != nil {
		return 0, err
	}
	if len(urns) == 0 {
		r.log.Info().Int("age_hours", ageHours).Msg("no phantom-live matches to drain")
		return 0, nil
	}
	r.log.Info().Int("count", len(urns)).Int("age_hours", ageHours).Msg("draining phantom-live matches")
	updated := 0
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for _, urn := range urns {
		select {
		case <-ctx.Done():
			return updated, ctx.Err()
		case <-ticker.C:
		}
		if err := r.RefreshFromFixture(ctx, urn); err != nil {
			r.log.Warn().Err(err).Str("urn", urn).Msg("drain: refresh failed")
			continue
		}
		updated++
	}
	r.log.Info().Int("considered", len(urns)).Int("refreshed", updated).Msg("phantom-live drain complete")
	return updated, nil
}

func nullableTimeISO(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}

// RefreshFromFixture fetches the latest fixture metadata from REST and
// applies it to an EXISTING match row. Called from the fixture_change
// handler when Oddin signals a NEW or DATE_TIME change for a match we
// already have. No-op when the REST client isn't configured or the
// fixture endpoint returns 404. Returns nil on best-effort failures so
// the caller never errors on metadata refresh.
func (r *Resolver) RefreshFromFixture(ctx context.Context, matchURN string) error {
	matchID, ok, err := store.FindMatchByURN(ctx, r.st.Pool(), matchURN)
	if err != nil {
		return err
	}
	if !ok {
		return nil // unknown match — odds_change/handler will create it via ResolveMatch
	}
	fx, err := r.fetchFixture(ctx, matchURN)
	if err != nil || fx == nil {
		// 404 or transient error — log via caller and move on.
		return err
	}

	// Re-apply the sport blocklist on refresh. An existing row for a
	// blocked sport stays where it is (grandfathered); we just skip
	// updating its metadata from this fixture_change.
	if r.sportBlocked(fx.Fixture.Tournament.Sport) {
		r.log.Debug().
			Str("match_urn", matchURN).
			Str("sport_urn", fx.Fixture.Tournament.Sport.ID).
			Msg("refresh skipped: sport on blocklist")
		return nil
	}
	merged := r.merge(MatchContext{MatchURN: matchURN}, fx)

	// Resolve tournament (creates sport/category/tournament if needed)
	// so we can update the match's tournament_id when it changed (rare
	// but documented as a possible NEW/DATE_TIME side effect).
	tournamentID, sportID, err := r.resolveTournament(ctx, merged.TournamentURN, fx, []byte(`{"refresh":true}`))
	if err != nil {
		return err
	}
	homeCompID, awayCompID := r.resolveMatchCompetitors(ctx, sportID, merged)
	mu := r.matchUpsert(merged, tournamentID, homeCompID, awayCompID)
	if _, err := store.UpsertMatch(ctx, r.st.Pool(), mu); err != nil {
		return fmt.Errorf("refresh upsert match: %w", err)
	}
	// Keep competitor profiles fresh on fixture_change so roster
	// updates (new players, renamed teams) flow through to outcome
	// labels without waiting for match re-creation.
	r.CacheCompetitorProfile(ctx, merged.HomeTeamURN)
	r.CacheCompetitorProfile(ctx, merged.AwayTeamURN)
	r.refreshTournamentMetadata(ctx, tournamentID, merged.TournamentURN)
	r.log.Info().
		Str("match_urn", matchURN).
		Int64("match_id", matchID).
		Int("tournament_id", tournamentID).
		Msg("fixture refreshed from REST")
	return nil
}

// resolveTournament guarantees a tournaments row exists for the supplied
// URN. When `fixture` is non-nil and contains a sport, we create the
// tournament under that sport's auto category. Otherwise the fallback
// sport/category is used. Returns (tournamentID, sportID, err) — the sport
// id is needed downstream by resolveCompetitor.
func (r *Resolver) resolveTournament(
	ctx context.Context,
	tURN string,
	fixture *oddinxml.FixtureResponse,
	rawPayload []byte,
) (int, int, error) {
	// Edge case: message had no tournament URN AND REST didn't supply one.
	// This shouldn't happen in practice but we still need a valid FK — fall
	// back to a synthetic per-sport "unknown" tournament so the matches
	// insert can succeed.
	if tURN == "" {
		tid, err := r.ensurePlaceholderTournament(ctx, r.defaultSportID, "unknown", "Unknown tournament")
		return tid, r.defaultSportID, err
	}

	if tid, _, sid, ok, err := store.FindTournamentByURN(ctx, r.st.Pool(), tURN); err != nil {
		return 0, 0, err
	} else if ok {
		return tid, sid, nil
	}

	// Unknown tournament. Decide which sport/category to nest it under.
	sportID := r.defaultSportID
	tournamentName := "Tournament " + tailOfURN(tURN)
	tournamentSlug := "t-" + tailOfURN(tURN)

	if fixture != nil && fixture.Fixture.Tournament.ID == tURN {
		// REST gave us the full tournament+sport context.
		ft := fixture.Fixture.Tournament
		if ft.Name != "" {
			tournamentName = ft.Name
		}
		if sid, err := r.resolveSport(ctx, ft.Sport); err != nil {
			r.log.Warn().Err(err).Str("sport_urn", ft.Sport.ID).
				Msg("sport upsert failed; falling back to default sport")
		} else if sid > 0 {
			sportID = sid
		}
	}

	categoryID, categoryCreated, err := store.EnsureCategoryForSport(ctx, r.st.Pool(), sportID)
	if err != nil {
		return 0, 0, err
	}
	if categoryCreated {
		// Oddin esports ships no category hierarchy; the row we just
		// created is a synthetic "Auto-mapped" bucket. For future
		// providers that do supply real categories this will grow into a
		// real mapping review, so wire the enqueue now. Synthetic URN
		// keeps the review_queue unique key stable without colliding
		// with provider-supplied URNs.
		catPayload, _ := json.Marshal(map[string]any{
			"sport_id":  sportID,
			"slug":      "auto",
			"name":      "Auto-mapped",
			"is_dummy":  true,
			"synthetic": true,
		})
		catURN := fmt.Sprintf("local:category:auto-sport-%d", sportID)
		if err := store.EnqueueReview(ctx, r.st.Pool(), store.ReviewEntry{
			EntityType:      "category",
			Provider:        "oddin",
			ProviderURN:     catURN,
			RawPayload:      catPayload,
			CreatedEntityID: fmt.Sprintf("%d", categoryID),
		}); err != nil {
			return 0, 0, fmt.Errorf("enqueue review (category): %w", err)
		}
	}

	tid, err := store.EnsureTournament(ctx, r.st.Pool(), categoryID, tURN, tournamentSlug, tournamentName)
	if err != nil {
		return 0, 0, err
	}

	// Best-effort: populate risk_tier so the sidebar can rank this
	// tournament from first sight. Errors are non-fatal — we'll retry
	// on the next fixture_change or catch it in the offline backfill.
	r.refreshTournamentMetadata(ctx, tid, tURN)

	payload, _ := json.Marshal(map[string]any{
		"provider_urn": tURN,
		"category_id":  categoryID,
		"sport_id":     sportID,
		"name":         tournamentName,
		"raw_preview":  truncate(string(rawPayload), 1024),
	})
	if err := store.EnqueueReview(ctx, r.st.Pool(), store.ReviewEntry{
		EntityType:      "tournament",
		Provider:        "oddin",
		ProviderURN:     tURN,
		RawPayload:      payload,
		CreatedEntityID: fmt.Sprintf("%d", tid),
	}); err != nil {
		return 0, 0, fmt.Errorf("enqueue review (tournament): %w", err)
	}
	return tid, sportID, nil
}

// resolveMatchCompetitors upserts home/away competitors for the match and
// returns their local ids. Best-effort: on any resolve error we log and
// return (null, null) so the match upsert can still proceed with inline
// team-name fields.
func (r *Resolver) resolveMatchCompetitors(
	ctx context.Context,
	sportID int,
	m MatchContext,
) (sql.NullInt32, sql.NullInt32) {
	home := r.resolveCompetitor(ctx, sportID, m.HomeTeam, m.HomeTeamURN)
	away := r.resolveCompetitor(ctx, sportID, m.AwayTeam, m.AwayTeamURN)
	return home, away
}

// resolveCompetitor upserts a single competitor and enqueues a mapping
// review row when the competitor was newly created. Returns a NULL
// sql.NullInt32 when the name is empty or "TBD" — the match row keeps its
// inline team-name fields but its FK stays null until a real name arrives.
func (r *Resolver) resolveCompetitor(
	ctx context.Context,
	sportID int,
	name, urn string,
) sql.NullInt32 {
	if sportID == 0 {
		return sql.NullInt32{}
	}
	trimmed := strings.TrimSpace(name)
	if trimmed == "" || trimmed == "TBD" {
		return sql.NullInt32{}
	}
	slug := slugify(trimmed)
	if slug == "" {
		return sql.NullInt32{}
	}

	// Fast path: look up by URN or (sport, slug) to skip the write
	// altogether when we've already mapped this team. Cuts INSERT
	// attempts on the hot odds_change path.
	if urn != "" {
		if id, ok, err := store.FindCompetitorByURN(ctx, r.st.Pool(), urn); err == nil && ok {
			return sql.NullInt32{Int32: int32(id), Valid: true}
		}
	} else {
		if id, ok, err := store.FindCompetitorBySportSlug(ctx, r.st.Pool(), sportID, slug); err == nil && ok {
			return sql.NullInt32{Int32: int32(id), Valid: true}
		}
	}

	id, created, err := store.EnsureCompetitor(ctx, r.st.Pool(), store.CompetitorUpsert{
		SportID:     sportID,
		ProviderURN: urn,
		Slug:        slug,
		Name:        trimmed,
	})
	if err != nil {
		r.log.Warn().Err(err).Int("sport_id", sportID).
			Str("urn", urn).Str("name", trimmed).
			Msg("competitor upsert failed; match will store inline team name only")
		return sql.NullInt32{}
	}

	if created {
		// Synthetic URN for URN-less competitors: stable per (sport,
		// slug) so the review-queue unique key doesn't collide across
		// different teams with missing URNs.
		reviewURN := urn
		if reviewURN == "" {
			reviewURN = fmt.Sprintf("local:competitor:sport-%d:%s", sportID, slug)
		}
		payload, _ := json.Marshal(map[string]any{
			"sport_id":     sportID,
			"provider_urn": nullableString(urn),
			"slug":         slug,
			"name":         trimmed,
		})
		if err := store.EnqueueReview(ctx, r.st.Pool(), store.ReviewEntry{
			EntityType:      "competitor",
			Provider:        "oddin",
			ProviderURN:     reviewURN,
			RawPayload:      payload,
			CreatedEntityID: fmt.Sprintf("%d", id),
		}); err != nil {
			r.log.Warn().Err(err).Int("competitor_id", id).
				Msg("competitor review enqueue failed")
		}
	}
	return sql.NullInt32{Int32: int32(id), Valid: true}
}

func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// resolveSport upserts a sport keyed by Oddin's URN. Returns 0 + nil when
// the supplied entry is empty (caller should fall back to default sport).
func (r *Resolver) resolveSport(ctx context.Context, fs oddinxml.FixtureSport) (int, error) {
	if fs.ID == "" {
		return 0, nil
	}
	if id, ok, err := store.FindSportByURN(ctx, r.st.Pool(), fs.ID); err != nil {
		return 0, err
	} else if ok {
		return id, nil
	}
	name := fs.Name
	if name == "" {
		name = "Sport " + tailOfURN(fs.ID)
	}
	slug := slugify(fs.Abbr)
	if slug == "" {
		slug = "s-" + tailOfURN(fs.ID)
	}
	id, err := store.EnsureSport(ctx, r.st.Pool(), fs.ID, slug, name, "esport")
	if err != nil {
		// Most likely a slug-collision (the seed reserves cs2/dota2/lol/
		// valorant). Retry with a URN-suffixed slug so we always converge
		// to a row.
		id, err = store.EnsureSport(ctx, r.st.Pool(), fs.ID, "s-"+tailOfURN(fs.ID), name, "esport")
		if err != nil {
			return 0, err
		}
	}

	payload, _ := json.Marshal(map[string]any{
		"provider_urn": fs.ID,
		"name":         name,
		"abbreviation": fs.Abbr,
	})
	_ = store.EnqueueReview(ctx, r.st.Pool(), store.ReviewEntry{
		EntityType:      "sport",
		Provider:        "oddin",
		ProviderURN:     fs.ID,
		RawPayload:      payload,
		CreatedEntityID: fmt.Sprintf("%d", id),
	})
	return id, nil
}

// ensurePlaceholderTournament creates (or fetches) a synthetic tournament
// under a sport's auto category. Used as a last-resort FK target when both
// the message AND the REST fallback failed to give us a tournament URN.
func (r *Resolver) ensurePlaceholderTournament(ctx context.Context, sportID int, slug, name string) (int, error) {
	categoryID, _, err := store.EnsureCategoryForSport(ctx, r.st.Pool(), sportID)
	if err != nil {
		return 0, err
	}
	urn := fmt.Sprintf("od:tournament:placeholder-sport-%d-%s", sportID, slug)
	return store.EnsureTournament(ctx, r.st.Pool(), categoryID, urn, slug, name)
}

// fetchFixture calls /v1/sports/{lang}/sport_events/{eventURN}/fixture.
// Returns nil when REST is unavailable or the event isn't known to Oddin.
func (r *Resolver) fetchFixture(ctx context.Context, eventURN string) (*oddinxml.FixtureResponse, error) {
	if r.rc == nil {
		return nil, fmt.Errorf("oddin rest client not configured")
	}
	body, err := r.rc.SportEventFixture(ctx, restLang, eventURN)
	if err != nil {
		if oddinrest.IsNotFound(err) {
			return nil, fmt.Errorf("sport event not found: %s", eventURN)
		}
		return nil, err
	}
	var fx oddinxml.FixtureResponse
	if err := xml.Unmarshal(body, &fx); err != nil {
		return nil, fmt.Errorf("unmarshal fixture: %w", err)
	}
	if fx.Fixture.ID == "" {
		// Oddin returned the generic error envelope inside a 200; treat as
		// not-found so callers fall back to placeholder.
		return nil, fmt.Errorf("empty fixture response for %s", eventURN)
	}
	return &fx, nil
}

// merge overlays REST data on top of the AMQP-derived MatchContext. AMQP
// values win when REST is missing them; REST values win otherwise.
func (r *Resolver) merge(in MatchContext, fx *oddinxml.FixtureResponse) MatchContext {
	out := in
	if fx == nil {
		return out
	}
	f := fx.Fixture
	if out.TournamentURN == "" {
		out.TournamentURN = f.Tournament.ID
	}
	if out.Status == "" {
		out.Status = mapFixtureStatus(f.Status)
	}
	if out.ScheduledAt.IsZero() {
		if t, err := parseFixtureTime(f.Scheduled); err == nil {
			out.ScheduledAt = t
		} else if t, err := parseFixtureTime(f.StartTime); err == nil {
			out.ScheduledAt = t
		}
	}
	for _, c := range f.Competitors.Competitors {
		switch c.Qualifier {
		case "home":
			if out.HomeTeam == "" {
				out.HomeTeam = c.Name
			}
			if out.HomeTeamURN == "" {
				out.HomeTeamURN = c.ID
			}
		case "away":
			if out.AwayTeam == "" {
				out.AwayTeam = c.Name
			}
			if out.AwayTeamURN == "" {
				out.AwayTeamURN = c.ID
			}
		}
	}
	for _, info := range f.ExtraInfo.Items {
		if info.Key == "best_of" && out.BestOf == 0 {
			if v := atoi16(info.Value); v > 0 {
				out.BestOf = v
			}
		}
	}
	return out
}

func (r *Resolver) matchUpsert(c MatchContext, tournamentID int, homeCompID, awayCompID sql.NullInt32) store.MatchUpsert {
	out := store.MatchUpsert{
		TournamentID:     tournamentID,
		ProviderURN:      c.MatchURN,
		HomeTeam:         defaultString(c.HomeTeam, "TBD"),
		AwayTeam:         defaultString(c.AwayTeam, "TBD"),
		Status:           defaultString(c.Status, "not_started"),
		HomeCompetitorID: homeCompID,
		AwayCompetitorID: awayCompID,
	}
	if c.HomeTeamURN != "" {
		out.HomeTeamURN = sql.NullString{String: c.HomeTeamURN, Valid: true}
	}
	if c.AwayTeamURN != "" {
		out.AwayTeamURN = sql.NullString{String: c.AwayTeamURN, Valid: true}
	}
	if !c.ScheduledAt.IsZero() {
		out.ScheduledAt = sql.NullTime{Time: c.ScheduledAt, Valid: true}
	}
	if c.OddinStatusCode != 0 {
		out.OddinStatusCode = sql.NullInt16{Int16: c.OddinStatusCode, Valid: true}
	}
	if c.BestOf != 0 {
		out.BestOf = sql.NullInt16{Int16: c.BestOf, Valid: true}
	}
	return out
}

// mapFixtureStatus maps Oddin's fixture status strings to our match_status
// enum. Anything unfamiliar collapses to "" so the caller's default
// ("not_started") wins.
func mapFixtureStatus(s string) string {
	switch strings.ToLower(s) {
	case "not_started", "scheduled":
		return "not_started"
	case "live", "in_progress", "started":
		return "live"
	case "closed", "ended", "finished":
		return "closed"
	case "cancelled", "canceled":
		return "cancelled"
	case "suspended":
		return "suspended"
	}
	return ""
}

// parseFixtureTime accepts the Oddin "2026-04-18T06:14:00" form (no zone,
// implicit UTC) and the standard RFC 3339 form.
func parseFixtureTime(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, fmt.Errorf("empty time")
	}
	for _, layout := range []string{
		time.RFC3339,
		time.RFC3339Nano,
		"2006-01-02T15:04:05",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognised time format %q", s)
}

func defaultString(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…(truncated)"
}

// tailOfURN extracts the segment after the last colon — the numeric id for
// "od:sport:19" → "19".
func tailOfURN(urn string) string {
	if i := strings.LastIndex(urn, ":"); i >= 0 && i < len(urn)-1 {
		return urn[i+1:]
	}
	return urn
}

// slugify produces a lowercase, dash-separated slug from a free-form name.
// Returns "" when the input has no alphanumeric content.
func slugify(name string) string {
	var b strings.Builder
	prevDash := true
	for _, ch := range strings.ToLower(name) {
		switch {
		case ch >= 'a' && ch <= 'z', ch >= '0' && ch <= '9':
			b.WriteRune(ch)
			prevDash = false
		default:
			if !prevDash {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

func atoi16(s string) int16 {
	var v int16
	for _, ch := range s {
		if ch < '0' || ch > '9' {
			return 0
		}
		v = v*10 + int16(ch-'0')
	}
	return v
}
