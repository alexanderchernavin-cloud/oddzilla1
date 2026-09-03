package store

import (
	"context"
	"database/sql"
	"fmt"
)

// EnsureSport upserts a sport keyed by (provider, provider_urn). The name
// is only written on insert — operators may rename sports in /admin and
// the feed must not clobber that.
func EnsureSport(ctx context.Context, db pgxRunner, providerURN, slug, name, kind string) (int, error) {
	const q = `
INSERT INTO sports (provider, provider_urn, slug, name, kind)
VALUES ($1, $2, $3, $4, $5::sport_kind)
ON CONFLICT (provider, provider_urn) DO UPDATE
   SET active = TRUE
RETURNING id`
	var id int
	if err := db.QueryRow(ctx, q, Provider, providerURN, slug, name, kind).Scan(&id); err != nil {
		return 0, fmt.Errorf("ensure sport %s: %w", slug, err)
	}
	return id, nil
}

// EnsureCategory upserts a (sport_id, slug)-keyed category. Fonbet has no
// category ids, so the slug is derived from the league-name prefix and
// provider_urn stays NULL.
func EnsureCategory(ctx context.Context, db pgxRunner, sportID int, slug, name string) (int, error) {
	const q = `
INSERT INTO categories (sport_id, provider_urn, slug, name, is_dummy)
VALUES ($1, NULL, $2, $3, FALSE)
ON CONFLICT (sport_id, slug) DO UPDATE
   SET active = TRUE,
       name   = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE categories.name END
RETURNING id`
	var id int
	if err := db.QueryRow(ctx, q, sportID, slug, name).Scan(&id); err != nil {
		return 0, fmt.Errorf("ensure category %s: %w", slug, err)
	}
	return id, nil
}

// EnsureTournament upserts a tournaments row keyed by provider_urn.
func EnsureTournament(ctx context.Context, db pgxRunner, categoryID int, providerURN, slug, name string) (int, error) {
	const q = `
INSERT INTO tournaments (category_id, provider_urn, slug, name)
VALUES ($1, $2, $3, $4)
ON CONFLICT (provider_urn) DO UPDATE
   SET name        = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE tournaments.name END,
       category_id = EXCLUDED.category_id,
       active      = TRUE
RETURNING id`
	var id int
	if err := db.QueryRow(ctx, q, categoryID, providerURN, slug, name).Scan(&id); err != nil {
		return 0, fmt.Errorf("ensure tournament %s: %w", providerURN, err)
	}
	return id, nil
}

// EnsureCompetitor upserts a competitors row keyed by (provider,
// provider_urn). The slug carries the Fonbet team id so two "Dynamo"
// rows in one sport never trip competitors_sport_slug.
func EnsureCompetitor(ctx context.Context, db pgxRunner, sportID int, providerURN, slug, name string) (int, error) {
	const q = `
INSERT INTO competitors (sport_id, provider, provider_urn, slug, name)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (provider, provider_urn) WHERE provider_urn IS NOT NULL DO UPDATE
   SET name   = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE competitors.name END,
       active = TRUE
RETURNING id`
	var id int
	if err := db.QueryRow(ctx, q, sportID, Provider, providerURN, slug, name).Scan(&id); err != nil {
		return 0, fmt.Errorf("ensure competitor %s: %w", providerURN, err)
	}
	return id, nil
}

// MatchUpsert is the match row we write per Fonbet level-1 event.
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
	Status           string // not_started | live (lifecycle regressions are refused by UpdateMatchStatus)
}

// UpsertMatch creates or refreshes a match. Status is written on insert
// only; transitions go through UpdateMatchStatus so the forward-only
// guard applies.
func UpsertMatch(ctx context.Context, db pgxRunner, m MatchUpsert) (int64, error) {
	const q = `
INSERT INTO matches (tournament_id, provider_urn, home_team, away_team,
                     home_team_urn, away_team_urn,
                     home_competitor_id, away_competitor_id,
                     scheduled_at, status, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::match_status, NOW())
ON CONFLICT (provider_urn) DO UPDATE
   SET tournament_id      = EXCLUDED.tournament_id,
       home_team          = CASE WHEN EXCLUDED.home_team <> '' THEN EXCLUDED.home_team ELSE matches.home_team END,
       away_team          = CASE WHEN EXCLUDED.away_team <> '' THEN EXCLUDED.away_team ELSE matches.away_team END,
       home_competitor_id = COALESCE(EXCLUDED.home_competitor_id, matches.home_competitor_id),
       away_competitor_id = COALESCE(EXCLUDED.away_competitor_id, matches.away_competitor_id),
       scheduled_at       = COALESCE(EXCLUDED.scheduled_at, matches.scheduled_at),
       updated_at         = NOW()
RETURNING id`
	var id int64
	err := db.QueryRow(ctx, q,
		m.TournamentID, m.ProviderURN, m.HomeTeam, m.AwayTeam,
		m.HomeTeamURN, m.AwayTeamURN,
		m.HomeCompetitorID, m.AwayCompetitorID,
		m.ScheduledAt, m.Status,
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("upsert match %s: %w", m.ProviderURN, err)
	}
	return id, nil
}

// UpdateMatchStatus applies a lifecycle transition with the same
// forward-only guard feed-ingester uses: terminal states stick, nothing
// goes back to not_started, same→same is a no-op. Returns whether a row
// changed. The `live` branch also snapshots prematch odds (ZillaTips).
func UpdateMatchStatus(ctx context.Context, db pgxRunner, matchID int64, status string) (bool, error) {
	if status == "live" {
		var changed bool
		if err := db.QueryRow(ctx, `
WITH upd AS (
  UPDATE matches
     SET status = 'live'::match_status,
         live_started_at = COALESCE(live_started_at, NOW()),
         updated_at = NOW()
   WHERE id = $1
     AND status::text NOT IN ('closed','cancelled','live')
   RETURNING id
), backfill AS (
  UPDATE market_outcomes mo
     SET prematch_odds = mo.published_odds
    FROM markets m
    JOIN upd ON upd.id = m.match_id
   WHERE m.id = mo.market_id
     AND mo.prematch_odds IS NULL
     AND mo.published_odds IS NOT NULL
  RETURNING 1
)
SELECT EXISTS (SELECT 1 FROM upd)`, matchID).Scan(&changed); err != nil {
			return false, fmt.Errorf("update match status (live): %w", err)
		}
		return changed, nil
	}
	ct, err := db.Exec(ctx, `
UPDATE matches
   SET status = $2::match_status, updated_at = NOW()
 WHERE id = $1
   AND status::text NOT IN ('closed','cancelled')
   AND status::text <> $2
   AND $2 <> 'not_started'`, matchID, status)
	if err != nil {
		return false, fmt.Errorf("update match status: %w", err)
	}
	return ct.RowsAffected() > 0, nil
}

// UpdateMatchLiveScore writes the scoreboard JSON (nil clears it).
func UpdateMatchLiveScore(ctx context.Context, db pgxRunner, matchID int64, payload []byte) error {
	if payload == nil {
		if _, err := db.Exec(ctx, `UPDATE matches SET live_score = NULL, updated_at = NOW() WHERE id = $1`, matchID); err != nil {
			return fmt.Errorf("clear match live_score: %w", err)
		}
		return nil
	}
	if _, err := db.Exec(ctx, `UPDATE matches SET live_score = $2::jsonb, updated_at = NOW() WHERE id = $1`, matchID, payload); err != nil {
		return fmt.Errorf("update match live_score: %w", err)
	}
	return nil
}
