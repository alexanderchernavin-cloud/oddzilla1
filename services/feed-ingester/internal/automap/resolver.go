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

type Resolver struct {
	st  *store.Store
	rc  *oddinrest.Client // may be nil → fallback-only mode
	log zerolog.Logger

	defaultSportID    int
	defaultCategoryID int
}

// New builds a Resolver. `rc` may be nil — in that case we never call REST
// and every unknown match becomes a placeholder under the fallback
// sport/category.
func New(st *store.Store, rc *oddinrest.Client, log zerolog.Logger, fallbackSportID, fallbackCategoryID int) *Resolver {
	return &Resolver{
		st:                st,
		rc:                rc,
		log:               log,
		defaultSportID:    fallbackSportID,
		defaultCategoryID: fallbackCategoryID,
	}
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
// category, tournament, and match rows on first sight (using REST data when
// possible, falling back to placeholders when not).
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

	// Merge fixture data into the context (fixture wins where both have a
	// value, since REST is authoritative). When fixture is nil we fall
	// through with whatever the message gave us.
	merged := r.merge(reqCtx, fixture)

	tournamentID, err := r.resolveTournament(ctx, merged.TournamentURN, fixture, rawPayload)
	if err != nil {
		return 0, err
	}

	mu := r.matchUpsert(merged, tournamentID)
	id, err := store.UpsertMatch(ctx, r.st.Pool(), mu)
	if err != nil {
		return 0, fmt.Errorf("upsert match: %w", err)
	}

	// Enqueue for admin review so an operator can rename or re-categorise
	// any auto-created entity. Idempotent on (provider, urn, entity_type).
	if err := store.EnqueueReview(ctx, r.st.Pool(), store.ReviewEntry{
		EntityType:      "match",
		Provider:        "oddin",
		ProviderURN:     reqCtx.MatchURN,
		RawPayload:      rawPayload,
		CreatedEntityID: fmt.Sprintf("%d", id),
	}); err != nil {
		return 0, fmt.Errorf("enqueue review (match): %w", err)
	}
	return id, nil
}

// resolveTournament guarantees a tournaments row exists for the supplied
// URN. When `fixture` is non-nil and contains a sport, we create the
// tournament under that sport's auto category. Otherwise the fallback
// sport/category is used.
func (r *Resolver) resolveTournament(
	ctx context.Context,
	tURN string,
	fixture *oddinxml.FixtureResponse,
	rawPayload []byte,
) (int, error) {
	// Edge case: message had no tournament URN AND REST didn't supply one.
	// This shouldn't happen in practice but we still need a valid FK — fall
	// back to a synthetic per-sport "unknown" tournament so the matches
	// insert can succeed.
	if tURN == "" {
		return r.ensurePlaceholderTournament(ctx, r.defaultSportID, "unknown", "Unknown tournament")
	}

	if tid, _, _, ok, err := store.FindTournamentByURN(ctx, r.st.Pool(), tURN); err != nil {
		return 0, err
	} else if ok {
		return tid, nil
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

	categoryID, err := store.EnsureCategoryForSport(ctx, r.st.Pool(), sportID)
	if err != nil {
		return 0, err
	}

	tid, err := store.EnsureTournament(ctx, r.st.Pool(), categoryID, tURN, tournamentSlug, tournamentName)
	if err != nil {
		return 0, err
	}

	payload, _ := json.Marshal(map[string]any{
		"provider_urn":      tURN,
		"category_id":       categoryID,
		"sport_id":          sportID,
		"name":              tournamentName,
		"raw_preview":       truncate(string(rawPayload), 1024),
	})
	if err := store.EnqueueReview(ctx, r.st.Pool(), store.ReviewEntry{
		EntityType:      "tournament",
		Provider:        "oddin",
		ProviderURN:     tURN,
		RawPayload:      payload,
		CreatedEntityID: fmt.Sprintf("%d", tid),
	}); err != nil {
		return 0, fmt.Errorf("enqueue review (tournament): %w", err)
	}
	return tid, nil
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
	categoryID, err := store.EnsureCategoryForSport(ctx, r.st.Pool(), sportID)
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

func (r *Resolver) matchUpsert(c MatchContext, tournamentID int) store.MatchUpsert {
	out := store.MatchUpsert{
		TournamentID: tournamentID,
		ProviderURN:  c.MatchURN,
		HomeTeam:     defaultString(c.HomeTeam, "TBD"),
		AwayTeam:     defaultString(c.AwayTeam, "TBD"),
		Status:       defaultString(c.Status, "not_started"),
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
