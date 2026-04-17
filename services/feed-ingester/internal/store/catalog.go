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
	TournamentID    int
	ProviderURN     string
	HomeTeam        string
	AwayTeam        string
	HomeTeamURN     sql.NullString
	AwayTeamURN     sql.NullString
	ScheduledAt     sql.NullTime
	Status          string // normalized: not_started|live|closed|cancelled|suspended
	OddinStatusCode sql.NullInt16
	BestOf          sql.NullInt16
}

func UpsertMatch(ctx context.Context, db pgxRunner, m MatchUpsert) (int64, error) {
	const q = `
INSERT INTO matches (tournament_id, provider_urn, home_team, away_team,
                     home_team_urn, away_team_urn, scheduled_at, status,
                     oddin_status_code, best_of, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::match_status, $9, $10, NOW())
ON CONFLICT (provider_urn) DO UPDATE
   SET home_team         = CASE WHEN EXCLUDED.home_team  <> '' THEN EXCLUDED.home_team  ELSE matches.home_team  END,
       away_team         = CASE WHEN EXCLUDED.away_team  <> '' THEN EXCLUDED.away_team  ELSE matches.away_team  END,
       scheduled_at      = COALESCE(EXCLUDED.scheduled_at, matches.scheduled_at),
       status            = EXCLUDED.status,
       oddin_status_code = COALESCE(EXCLUDED.oddin_status_code, matches.oddin_status_code),
       best_of           = COALESCE(EXCLUDED.best_of, matches.best_of),
       updated_at        = NOW()
RETURNING id`
	var id int64
	err := db.QueryRow(ctx, q,
		m.TournamentID, m.ProviderURN, m.HomeTeam, m.AwayTeam,
		m.HomeTeamURN, m.AwayTeamURN, m.ScheduledAt, m.Status,
		m.OddinStatusCode, m.BestOf,
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

// ─── Mapping review queue ──────────────────────────────────────────────────

type ReviewEntry struct {
	EntityType      string // "sport" | "tournament" | "match" | "market_type"
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
