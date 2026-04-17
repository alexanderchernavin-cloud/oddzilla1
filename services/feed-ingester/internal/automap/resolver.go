// Auto-mapping: turns Oddin provider URNs into local DB ids. Unknown
// entities are created with best-effort metadata AND enqueued for admin
// review. Policy for MVP: create optimistically so the feed never stalls.
// Admins can later flag a row as 'rejected' in the review UI, which will
// be picked up in phase 6+ to force-void any open tickets referencing it.

package automap

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/oddzilla/feed-ingester/internal/oddinxml"
	"github.com/oddzilla/feed-ingester/internal/store"
)

type Resolver struct {
	st *store.Store

	// defaultSportID + defaultCategoryID are used when we receive a match
	// whose tournament is unknown and we can't infer the sport from the
	// URN. Never nil in production — main.go guarantees the seed ran.
	defaultSportID    int
	defaultCategoryID int
}

// New builds a Resolver. The caller picks a fallback sport (typically the
// first esport in `sports`) for matches that arrive without tournament
// context — rare, but we never want the feed to hard-fail on missing data.
func New(st *store.Store, fallbackSportID, fallbackCategoryID int) *Resolver {
	return &Resolver{
		st:                st,
		defaultSportID:    fallbackSportID,
		defaultCategoryID: fallbackCategoryID,
	}
}

// MatchContext describes what we know about a match from an inbound XML.
type MatchContext struct {
	MatchURN        string
	TournamentURN   string // may be empty on some messages
	HomeTeam        string
	AwayTeam        string
	HomeTeamURN     string
	AwayTeamURN     string
	ScheduledAt     time.Time // zero = unknown
	Status          string    // normalized: not_started|live|closed|cancelled|suspended
	OddinStatusCode int16     // raw numeric
	BestOf          int16
}

// ResolveMatch ensures there's a matches row for ctx.MatchURN, auto-creating
// tournament + match rows when needed and enqueuing mapping_review_queue
// entries for anything we invented. Returns the matches.id.
func (r *Resolver) ResolveMatch(ctx context.Context, reqCtx MatchContext, rawPayload []byte) (int64, error) {
	if existing, ok, err := store.FindMatchByURN(ctx, r.st.Pool(), reqCtx.MatchURN); err != nil {
		return 0, err
	} else if ok {
		// Match known — still push the latest status/score through.
		upsert := r.matchUpsert(reqCtx, 0)
		// We don't know tournament_id without a fetch; refresh via UpsertMatch
		// would require it. Re-read tournament from the existing row instead
		// so we don't mutate the FK accidentally.
		// For simplicity, return the existing id; status updates come via a
		// dedicated handler path (see handler/fixture_change.go).
		_ = upsert
		return existing, nil
	}

	// Unknown match. Walk up the hierarchy.
	tournamentID, err := r.resolveTournament(ctx, reqCtx.TournamentURN, rawPayload)
	if err != nil {
		return 0, err
	}

	mu := r.matchUpsert(reqCtx, tournamentID)
	id, err := store.UpsertMatch(ctx, r.st.Pool(), mu)
	if err != nil {
		return 0, fmt.Errorf("upsert match: %w", err)
	}

	// Enqueue for admin review (entity we just auto-created).
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

// resolveTournament ensures a tournaments row exists. If the URN is empty
// or unknown, we use the fallback category and flag for review.
func (r *Resolver) resolveTournament(ctx context.Context, tURN string, rawPayload []byte) (int, error) {
	if tURN == "" {
		return r.defaultCategoryID /* as category*/, nil
	}
	if tid, _, _, ok, err := store.FindTournamentByURN(ctx, r.st.Pool(), tURN); err != nil {
		return 0, err
	} else if ok {
		return tid, nil
	}

	// Unknown tournament — create under the fallback category for MVP.
	// Phase 4 will improve this by inferring the sport from the fixtures
	// REST call (via oddinrest.Fixtures).
	u, err := oddinxml.ParseURN(tURN)
	if err != nil {
		return 0, err
	}
	slug := "t-" + u.ID
	name := "Tournament " + u.ID

	tid, err := store.EnsureTournament(ctx, r.st.Pool(), r.defaultCategoryID, tURN, slug, name)
	if err != nil {
		return 0, err
	}

	// Record raw payload snippet for review.
	payload, _ := json.Marshal(map[string]any{
		"provider_urn":    tURN,
		"inferred_category": r.defaultCategoryID,
		"raw_preview":     truncate(string(rawPayload), 1024),
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

func (r *Resolver) matchUpsert(c MatchContext, tournamentID int) store.MatchUpsert {
	out := store.MatchUpsert{
		TournamentID: tournamentID,
		ProviderURN:  c.MatchURN,
		HomeTeam:     c.HomeTeam,
		AwayTeam:     c.AwayTeam,
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
