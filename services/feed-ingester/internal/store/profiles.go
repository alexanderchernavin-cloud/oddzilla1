// Competitor + player profile upserts. See migration 0008.
//
// Called from the automap resolver when a match is first created (or
// re-fetched from fixture_change). Keeps team names, icons, and active
// player rosters in sync so the API can render outcomes like
// od:player:10705 as "Myrwn" rather than the raw URN.

package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/oddzilla/feed-ingester/internal/oddinxml"
)

// UpsertCompetitorProfile writes one competitor + its player roster in
// a single transaction. Idempotent; safe to call repeatedly for the
// same URN (useful for periodic refresh).
func UpsertCompetitorProfile(ctx context.Context, pool *pgxpool.Pool, p *oddinxml.CompetitorProfile) error {
	if p == nil || p.Competitor.ID == "" {
		return nil
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	const competitorSQL = `
		INSERT INTO competitor_profiles (urn, name, abbreviation, icon_path, updated_at)
		VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NOW())
		ON CONFLICT (urn) DO UPDATE
		  SET name         = EXCLUDED.name,
		      abbreviation = EXCLUDED.abbreviation,
		      icon_path    = EXCLUDED.icon_path,
		      updated_at   = NOW()
	`
	if _, err := tx.Exec(
		ctx, competitorSQL,
		p.Competitor.ID, p.Competitor.Name, p.Competitor.Abbreviation, p.Competitor.IconPath,
	); err != nil {
		return fmt.Errorf("upsert competitor: %w", err)
	}

	const playerSQL = `
		INSERT INTO player_profiles (urn, name, full_name, competitor_urn, sport_urn, updated_at)
		VALUES ($1, $2, NULLIF($3, ''), $4, NULLIF($5, ''), NOW())
		ON CONFLICT (urn) DO UPDATE
		  SET name           = EXCLUDED.name,
		      full_name      = EXCLUDED.full_name,
		      competitor_urn = EXCLUDED.competitor_urn,
		      sport_urn      = EXCLUDED.sport_urn,
		      updated_at     = NOW()
	`
	for _, pl := range p.Players {
		if pl.ID == "" {
			continue
		}
		if _, err := tx.Exec(ctx, playerSQL, pl.ID, pl.Name, pl.FullName, p.Competitor.ID, pl.Sport); err != nil {
			return fmt.Errorf("upsert player %s: %w", pl.ID, err)
		}
	}
	return tx.Commit(ctx)
}

// CompetitorProfileExists returns true when we already cached a profile
// for this URN — used to skip redundant REST fetches for teams we've
// already seen recently.
func CompetitorProfileExists(ctx context.Context, pool *pgxpool.Pool, urn string) (bool, error) {
	if urn == "" {
		return false, nil
	}
	var exists bool
	err := pool.QueryRow(
		ctx,
		`SELECT EXISTS (SELECT 1 FROM competitor_profiles WHERE urn = $1)`,
		urn,
	).Scan(&exists)
	return exists, err
}

// MissingCompetitorURNs lists competitor URNs referenced by active
// matches (live / not_started) but not yet present in
// competitor_profiles. Used by the feed-ingester boot backfill to fetch
// profiles for matches ingested before the cache existed.
func MissingCompetitorURNs(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	rows, err := pool.Query(ctx, `
		SELECT DISTINCT urn FROM (
		  SELECT home_team_urn AS urn FROM matches WHERE status IN ('live','not_started') AND home_team_urn IS NOT NULL
		  UNION
		  SELECT away_team_urn AS urn FROM matches WHERE status IN ('live','not_started') AND away_team_urn IS NOT NULL
		) u
		WHERE urn NOT IN (SELECT urn FROM competitor_profiles)
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var urn string
		if err := rows.Scan(&urn); err != nil {
			return nil, err
		}
		out = append(out, urn)
	}
	return out, rows.Err()
}
