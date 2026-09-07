package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

// EnsureSport upserts a sport keyed by (provider, provider_urn). The name
// is only written on insert — operators may rename sports in /admin and
// the feed must not clobber that.
// Logos are stamped separately by ApplyLogos (Fonbet's line/logos catalogue).
//
// sports.slug carries its own global UNIQUE (sports_slug_key) that the
// (provider, provider_urn) ON CONFLICT does not cover. A Fonbet root whose
// pinned slug collides with an existing row — an operator-renamed sport, an
// Oddin sport sharing the name — would otherwise fail every cycle for every
// match under that sport. On that collision the slug is suffixed with the
// Fonbet id and the insert retried; a second collision is a real error.
func EnsureSport(ctx context.Context, db pgxRunner, providerURN, slug, name, kind string) (int, error) {
	id, err := insertSport(ctx, db, providerURN, slug, name, kind)
	if err == nil {
		return id, nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "sports_slug_key" {
		alt := slug + "-fb-" + strings.TrimPrefix(providerURN, URNSport)
		id, rerr := insertSport(ctx, db, providerURN, alt, name, kind)
		if rerr == nil {
			return id, nil
		}
		return 0, fmt.Errorf("ensure sport %s: slug taken and fallback %q failed: %w", slug, alt, rerr)
	}
	return 0, fmt.Errorf("ensure sport %s: %w", slug, err)
}

func insertSport(ctx context.Context, db pgxRunner, providerURN, slug, name, kind string) (int, error) {
	const q = `
INSERT INTO sports (provider, provider_urn, slug, name, kind)
VALUES ($1, $2, $3, $4, $5::sport_kind)
ON CONFLICT (provider, provider_urn) DO UPDATE
   SET active = TRUE
RETURNING id`
	var id int
	err := db.QueryRow(ctx, q, Provider, providerURN, slug, name, kind).Scan(&id)
	return id, err
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

// DeactivateEmptyCategories retires Fonbet categories that hold no
// tournament at all, and returns how many it retired.
//
// A category derived from a league-name prefix can be emptied by the
// canonicaliser: when two spellings of one competition merge, the losing
// row's tournaments are re-homed by EnsureTournament's
// `category_id = EXCLUDED.category_id`, leaving a row with nothing under
// it. It renders nowhere on the storefront (the sidebar builds its
// buckets from the tournaments endpoint, which selects FROM tournaments)
// but did keep a line on /admin/categories forever.
//
// The predicate cannot flap, which is what makes a sweep safe here rather
// than merely convenient: nothing in the system ever sets
// `tournaments.active = false` — every writer only sets it TRUE — so this
// asks whether any tournament ROW points at the category, not whether one
// is currently in the offer. A quiet league between seasons keeps its row
// and keeps its category. Emptiness is reached only by a re-home or by an
// operator deleting the last tournament, and both are deliberate.
//
// Reversible by construction: EnsureCategory's ON CONFLICT sets
// `active = TRUE`, so the row comes straight back if Fonbet ever splits
// the competition again.
//
// `display_order` is cleared with the flag because a pin is a POSITION in
// the sequence an operator can see, and /admin/categories does not list
// an inactive row — leaving the pin would keep an invisible slot in the
// dense 1..N renumbering that POST /admin/categories/:id/order maintains,
// so the visible list and the stored sequence would disagree.
// `hidden_from_lists` is deliberately KEPT: that one is a standing
// decision about the content, and it should still hold if the row returns.
//
// Scoped to this provider's own sports, per invariant 10 — Oddin files
// every esports tournament under one synthetic dummy category, which is
// excluded anyway, but the scope is what makes that structural rather
// than incidental.
func DeactivateEmptyCategories(ctx context.Context, db pgxRunner) (int64, error) {
	const q = `
UPDATE categories c
   SET active = FALSE,
       display_order = NULL
 WHERE c.active
   AND NOT c.is_dummy
   AND EXISTS (SELECT 1 FROM sports s WHERE s.id = c.sport_id AND s.provider = $1)
   AND NOT EXISTS (SELECT 1 FROM tournaments t WHERE t.category_id = c.id)`
	tag, err := db.Exec(ctx, q, Provider)
	if err != nil {
		return 0, fmt.Errorf("deactivate empty categories: %w", err)
	}
	return tag.RowsAffected(), nil
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
