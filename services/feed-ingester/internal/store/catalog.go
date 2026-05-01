package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ─── Match lookup ──────────────────────────────────────────────────────────

// FindMatchByURN returns the match id for a given provider URN, or (0,
// false, nil) if not present.
func FindMatchByURN(ctx context.Context, db pgxRunner, providerURN string) (int64, bool, error) {
	const q = `SELECT id FROM matches WHERE provider_urn = $1`
	var id int64
	err := db.QueryRow(ctx, q, providerURN).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("find match: %w", err)
	}
	return id, true, nil
}

// ─── Tournament / category lookup ──────────────────────────────────────────

// FindTournamentByURN returns (id, category_id, sport_id, found, err).
func FindTournamentByURN(ctx context.Context, db pgxRunner, providerURN string) (int, int, int, bool, error) {
	const q = `
SELECT t.id, t.category_id, c.sport_id
  FROM tournaments t
  JOIN categories c ON c.id = t.category_id
 WHERE t.provider_urn = $1`
	var tid, cid, sid int
	err := db.QueryRow(ctx, q, providerURN).Scan(&tid, &cid, &sid)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, 0, 0, false, nil
		}
		return 0, 0, 0, false, fmt.Errorf("find tournament: %w", err)
	}
	return tid, cid, sid, true, nil
}

// ─── Match upsert (phase 3 happy path) ─────────────────────────────────────

// MatchUpsert is enough to create/update a matches row when we see one in
// odds_change / fixture_change messages.
type MatchUpsert struct {
	TournamentID     int
	ProviderURN      string
	HomeTeam         string
	AwayTeam         string
	HomeTeamURN      sql.NullString
	AwayTeamURN      sql.NullString
	HomeCompetitorID sql.NullInt32
	AwayCompetitorID sql.NullInt32
	ScheduledAt      sql.NullTime
	Status           string // normalized: not_started|live|closed|cancelled|suspended
	OddinStatusCode  sql.NullInt16
	BestOf           sql.NullInt16
}

func UpsertMatch(ctx context.Context, db pgxRunner, m MatchUpsert) (int64, error) {
	// tournament_id is overwritten only when the incoming row points at a
	// real tournament — never at a placeholder. Without this guard, a match
	// that was originally created under "Unknown tournament" (because the
	// auto-mapper's first REST fetch 404'd) could never be re-classified
	// once REST started returning the proper sport/tournament. The reverse
	// regression — re-pointing a properly-mapped match BACK to a
	// placeholder — would happen on every odds_change for a known match
	// without fixture context, and is what the "real-only" guard prevents.
	const q = `
INSERT INTO matches (tournament_id, provider_urn, home_team, away_team,
                     home_team_urn, away_team_urn,
                     home_competitor_id, away_competitor_id,
                     scheduled_at, status, oddin_status_code, best_of, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::match_status, $11, $12, NOW())
ON CONFLICT (provider_urn) DO UPDATE
   SET tournament_id      = CASE
                              WHEN EXISTS (
                                SELECT 1 FROM tournaments t
                                 WHERE t.id = EXCLUDED.tournament_id
                                   AND t.provider_urn NOT LIKE 'od:tournament:placeholder-%'
                              ) THEN EXCLUDED.tournament_id
                              ELSE matches.tournament_id
                            END,
       home_team          = CASE WHEN EXCLUDED.home_team  <> '' THEN EXCLUDED.home_team  ELSE matches.home_team  END,
       away_team          = CASE WHEN EXCLUDED.away_team  <> '' THEN EXCLUDED.away_team  ELSE matches.away_team  END,
       home_competitor_id = COALESCE(EXCLUDED.home_competitor_id, matches.home_competitor_id),
       away_competitor_id = COALESCE(EXCLUDED.away_competitor_id, matches.away_competitor_id),
       scheduled_at       = COALESCE(EXCLUDED.scheduled_at, matches.scheduled_at),
       status             = EXCLUDED.status,
       oddin_status_code  = COALESCE(EXCLUDED.oddin_status_code, matches.oddin_status_code),
       best_of            = COALESCE(EXCLUDED.best_of, matches.best_of),
       updated_at         = NOW()
RETURNING id`
	var id int64
	err := db.QueryRow(ctx, q,
		m.TournamentID, m.ProviderURN, m.HomeTeam, m.AwayTeam,
		m.HomeTeamURN, m.AwayTeamURN,
		m.HomeCompetitorID, m.AwayCompetitorID,
		m.ScheduledAt, m.Status, m.OddinStatusCode, m.BestOf,
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("upsert match: %w", err)
	}
	return id, nil
}

// ─── Tournament auto-create ────────────────────────────────────────────────

// EnsureTournament creates a tournaments row if the URN is unknown, under
// the given category. Returns the tournaments.id.
func EnsureTournament(ctx context.Context, db pgxRunner, categoryID int, providerURN, slug, name string) (int, error) {
	const q = `
INSERT INTO tournaments (category_id, provider_urn, slug, name)
VALUES ($1, $2, $3, $4)
ON CONFLICT (provider_urn) DO UPDATE
   SET name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE tournaments.name END
RETURNING id`
	var id int
	err := db.QueryRow(ctx, q, categoryID, providerURN, slug, name).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("ensure tournament: %w", err)
	}
	return id, nil
}

// UpdateTournamentRiskTier sets risk_tier on an existing tournaments row.
// No-op when riskTier <= 0 so callers can pass through REST responses that
// omitted the attribute without guarding.
func UpdateTournamentRiskTier(ctx context.Context, db pgxRunner, tournamentID int, riskTier int16) error {
	if riskTier <= 0 {
		return nil
	}
	if _, err := db.Exec(ctx,
		`UPDATE tournaments SET risk_tier = $2 WHERE id = $1`,
		tournamentID, riskTier,
	); err != nil {
		return fmt.Errorf("update tournament risk_tier: %w", err)
	}
	return nil
}

// TournamentRef is a minimal (id, urn) pair used by the metadata backfill
// tool to iterate tournaments that still need their risk_tier populated.
type TournamentRef struct {
	ID          int
	ProviderURN string
}

// TournamentsMissingRiskTier returns every active tournament whose
// risk_tier is still NULL. The backfill tool walks this list and calls
// the Oddin tournament-info endpoint for each.
func TournamentsMissingRiskTier(ctx context.Context, db pgxRunner) ([]TournamentRef, error) {
	rows, err := db.Query(ctx, `
SELECT id, provider_urn
  FROM tournaments
 WHERE active = TRUE
   AND risk_tier IS NULL
   AND provider_urn LIKE 'od:tournament:%'
 ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("select tournaments missing risk_tier: %w", err)
	}
	defer rows.Close()
	var out []TournamentRef
	for rows.Next() {
		var t TournamentRef
		if err := rows.Scan(&t.ID, &t.ProviderURN); err != nil {
			return nil, fmt.Errorf("scan tournament ref: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// PhantomStaleMatchURNs returns provider URNs of matches whose status is
// still `live` or `not_started` more than `ageHours` after their scheduled
// start. These are matches whose match_status_change message we missed
// (typically during a recovery gap after a postgres outage, or because
// Oddin's integration broker simply never emitted one — many fixtures
// transition not_started → closed without ever passing through live in
// the AMQP stream). The drain tool re-pulls the fixture from REST so the
// row's status reflects reality and the match drops out of listings.
func PhantomStaleMatchURNs(ctx context.Context, db pgxRunner, ageHours int) ([]string, error) {
	rows, err := db.Query(ctx, `
SELECT provider_urn
  FROM matches
 WHERE status IN ('live', 'not_started')
   AND scheduled_at IS NOT NULL
   AND scheduled_at < NOW() - make_interval(hours => $1)
   AND provider_urn LIKE 'od:match:%'
 ORDER BY scheduled_at`, ageHours)
	if err != nil {
		return nil, fmt.Errorf("select phantom-stale matches: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var urn string
		if err := rows.Scan(&urn); err != nil {
			return nil, fmt.Errorf("scan phantom-stale urn: %w", err)
		}
		out = append(out, urn)
	}
	return out, rows.Err()
}

// FindSportBySlug returns the sport id (or 0 if not found).
func FindSportBySlug(ctx context.Context, db pgxRunner, slug string) (int, bool, error) {
	var id int
	err := db.QueryRow(ctx, `SELECT id FROM sports WHERE slug = $1`, slug).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("find sport: %w", err)
	}
	return id, true, nil
}

// FindSportByURN returns the sport id keyed by Oddin's provider URN
// (e.g. "od:sport:19"). Returns (0, false, nil) when unseen.
func FindSportByURN(ctx context.Context, db pgxRunner, providerURN string) (int, bool, error) {
	var id int
	err := db.QueryRow(ctx,
		`SELECT id FROM sports WHERE provider = 'oddin' AND provider_urn = $1`,
		providerURN,
	).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("find sport by urn: %w", err)
	}
	return id, true, nil
}

// EnsureSport upserts a sport keyed by (provider, provider_urn). The slug
// must be unique across all sports — callers derive a stable one (typically
// from the URN's numeric tail). Returns the sports.id.
func EnsureSport(ctx context.Context, db pgxRunner, providerURN, slug, name, kind string) (int, error) {
	const q = `
INSERT INTO sports (provider, provider_urn, slug, name, kind)
VALUES ('oddin', $1, $2, $3, $4::sport_kind)
ON CONFLICT (provider, provider_urn) DO UPDATE
   SET name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE sports.name END,
       active = TRUE
RETURNING id`
	var id int
	err := db.QueryRow(ctx, q, providerURN, slug, name, kind).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("ensure sport: %w", err)
	}
	return id, nil
}

// UpdateMatchStatus updates only the match_status column on an existing
// match — used by fixture_change handlers when we need to flip status to
// 'cancelled' without rewriting the rest of the match row.
func UpdateMatchStatus(ctx context.Context, db pgxRunner, matchID int64, status string) error {
	_, err := db.Exec(ctx,
		`UPDATE matches SET status = $2::match_status, updated_at = NOW() WHERE id = $1`,
		matchID, status,
	)
	if err != nil {
		return fmt.Errorf("update match status: %w", err)
	}
	return nil
}

// EnsureCategoryForSport returns (id, inserted, err) for the auto-mapped
// category that sits directly under the given sport. Categories from Oddin
// don't always exist in the source feed — we keep one synthetic "Auto" row
// per sport to anchor tournaments. For other providers (future) that DO
// supply category URNs we'd want a provider-URN-keyed variant; this helper
// only handles the esports-style no-category case.
//
// `inserted` is true only when a new row was created (xmax trick), so
// callers can enqueue a mapping review entry exactly once per sport.
func EnsureCategoryForSport(ctx context.Context, db pgxRunner, sportID int) (int, bool, error) {
	const q = `
INSERT INTO categories (sport_id, provider_urn, slug, name, is_dummy)
VALUES ($1, NULL, 'auto', 'Auto-mapped', TRUE)
ON CONFLICT (sport_id, slug) DO UPDATE
   SET active = TRUE
RETURNING id, (xmax = 0) AS inserted`
	var id int
	var inserted bool
	err := db.QueryRow(ctx, q, sportID).Scan(&id, &inserted)
	if err != nil {
		return 0, false, fmt.Errorf("ensure auto category: %w", err)
	}
	return id, inserted, nil
}

// FindDummyCategoryForSport returns the is_dummy category id for a sport
// (seed guarantees one exists per esport).
func FindDummyCategoryForSport(ctx context.Context, db pgxRunner, sportID int) (int, error) {
	const q = `
SELECT id FROM categories
 WHERE sport_id = $1 AND is_dummy = TRUE
 ORDER BY id
 LIMIT 1`
	var id int
	err := db.QueryRow(ctx, q, sportID).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("find dummy category: %w", err)
	}
	return id, nil
}

// ─── Competitor upsert ─────────────────────────────────────────────────────

// FindCompetitorByURN returns the competitor id keyed by Oddin URN.
func FindCompetitorByURN(ctx context.Context, db pgxRunner, providerURN string) (int, bool, error) {
	var id int
	err := db.QueryRow(ctx,
		`SELECT id FROM competitors WHERE provider = 'oddin' AND provider_urn = $1`,
		providerURN,
	).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("find competitor by urn: %w", err)
	}
	return id, true, nil
}

// FindCompetitorBySportSlug returns the competitor id for a (sport, slug)
// pair. Used as a fallback when an AMQP message gave us a team name but no
// URN and we need to avoid creating a second row on the next odds_change.
func FindCompetitorBySportSlug(ctx context.Context, db pgxRunner, sportID int, slug string) (int, bool, error) {
	var id int
	err := db.QueryRow(ctx,
		`SELECT id FROM competitors WHERE sport_id = $1 AND slug = $2`,
		sportID, slug,
	).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("find competitor by slug: %w", err)
	}
	return id, true, nil
}

// CompetitorUpsert describes a team we want to persist. ProviderURN may be
// empty — in that case (sport_id, slug) is the conflict key; otherwise
// (provider, provider_urn) wins.
type CompetitorUpsert struct {
	SportID      int
	ProviderURN  string // empty = no URN key
	Slug         string
	Name         string
	Abbreviation sql.NullString
}

// EnsureCompetitor upserts a competitors row. Returns (id, inserted, err)
// where `inserted` is true when a new row was created (used by the resolver
// to decide whether to enqueue a mapping review entry).
func EnsureCompetitor(ctx context.Context, db pgxRunner, c CompetitorUpsert) (int, bool, error) {
	// xmax = 0 on newly inserted rows; any non-zero value means the row
	// existed and UPDATE ran. Reliable in single-statement INSERT ... ON
	// CONFLICT DO UPDATE contexts.
	const qWithURN = `
INSERT INTO competitors (sport_id, provider, provider_urn, slug, name, abbreviation)
VALUES ($1, 'oddin', $2, $3, $4, $5)
ON CONFLICT (provider, provider_urn) WHERE provider_urn IS NOT NULL DO UPDATE
   SET name         = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE competitors.name END,
       abbreviation = COALESCE(EXCLUDED.abbreviation, competitors.abbreviation),
       active       = TRUE
RETURNING id, (xmax = 0) AS inserted`

	const qNoURN = `
INSERT INTO competitors (sport_id, provider, slug, name, abbreviation)
VALUES ($1, 'oddin', $2, $3, $4)
ON CONFLICT (sport_id, slug) DO UPDATE
   SET name         = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE competitors.name END,
       abbreviation = COALESCE(EXCLUDED.abbreviation, competitors.abbreviation),
       active       = TRUE
RETURNING id, (xmax = 0) AS inserted`

	var id int
	var inserted bool
	if c.ProviderURN != "" {
		if err := db.QueryRow(ctx, qWithURN,
			c.SportID, c.ProviderURN, c.Slug, c.Name, c.Abbreviation,
		).Scan(&id, &inserted); err != nil {
			return 0, false, fmt.Errorf("ensure competitor (urn): %w", err)
		}
		return id, inserted, nil
	}
	if err := db.QueryRow(ctx, qNoURN,
		c.SportID, c.Slug, c.Name, c.Abbreviation,
	).Scan(&id, &inserted); err != nil {
		return 0, false, fmt.Errorf("ensure competitor (slug): %w", err)
	}
	return id, inserted, nil
}

// ─── Mapping review queue ──────────────────────────────────────────────────

type ReviewEntry struct {
	EntityType      string // "sport" | "category" | "tournament" | "match" | "competitor" | "market_type"
	Provider        string
	ProviderURN     string
	RawPayload      []byte // JSONB — raw XML message or a relevant subset
	CreatedEntityID string
}

// EnqueueReview inserts a pending row into mapping_review_queue. Idempotent
// on (provider, provider_urn, entity_type).
func EnqueueReview(ctx context.Context, db pgxRunner, e ReviewEntry) error {
	const q = `
INSERT INTO mapping_review_queue
  (entity_type, provider, provider_urn, raw_payload, created_entity_id)
VALUES ($1, $2, $3, $4::jsonb, $5)
ON CONFLICT (provider, provider_urn, entity_type) DO UPDATE
   SET raw_payload       = EXCLUDED.raw_payload,
       created_entity_id = COALESCE(EXCLUDED.created_entity_id, mapping_review_queue.created_entity_id)`
	if _, err := db.Exec(ctx, q,
		e.EntityType, e.Provider, e.ProviderURN, string(e.RawPayload), e.CreatedEntityID,
	); err != nil {
		return fmt.Errorf("enqueue review: %w", err)
	}
	return nil
}
