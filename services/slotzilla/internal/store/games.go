package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Candidate is a basketball fixture the game may run on: a CONFIRMED
// Sportradar mapping on a match that is live or about to be.
type Candidate struct {
	MatchID   int64
	SrMatchID int64
}

// Only a confirmed mapping reaches the game — a wrong one would settle
// spins on another fixture's play-by-play — and only basketball
// (sr_sport_id 2). The kickoff window bounds how many games are polled:
// six hours back covers overtime on a delayed tip-off, an hour ahead lets
// the row exist before the first spin.
const sqlSelectCandidates = `
SELECT m.id, msr.sr_match_id
  FROM match_sportradar_ids msr
  JOIN matches m ON m.id = msr.match_id
 WHERE msr.status = 'confirmed'
   AND msr.sr_sport_id = 2
   AND m.status IN ('not_started', 'live')
   AND m.scheduled_at BETWEEN now() - interval '6 hours' AND now() + interval '1 hour'
 ORDER BY m.scheduled_at, m.id`

func (s *Store) SelectCandidates(ctx context.Context) ([]Candidate, error) {
	rows, err := s.pool.Query(ctx, sqlSelectCandidates)
	if err != nil {
		return nil, fmt.Errorf("select candidates: %w", err)
	}
	defer rows.Close()
	var out []Candidate
	for rows.Next() {
		var c Candidate
		if err := rows.Scan(&c.MatchID, &c.SrMatchID); err != nil {
			return nil, fmt.Errorf("scan candidate: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

const sqlInsertGame = `
INSERT INTO slotzilla_games (match_id, sr_match_id, status, paytable_id)
VALUES ($1, $2, 'scheduled', $3)
ON CONFLICT (match_id) DO NOTHING`

// InsertGameIfAbsent creates the game row for a candidate. An existing
// row — whatever its status — is left alone, so an ended or voided game
// is never revived and an operator's pause is never undone.
func (s *Store) InsertGameIfAbsent(ctx context.Context, matchID, srMatchID int64, paytableID *int64) (bool, error) {
	tag, err := s.pool.Exec(ctx, sqlInsertGame, matchID, srMatchID, paytableID)
	if err != nil {
		return false, fmt.Errorf("insert game %d: %w", matchID, err)
	}
	return tag.RowsAffected() == 1, nil
}

// Game is a slotzilla_games row the engine is running, with the match's
// own lifecycle beside it.
type Game struct {
	MatchID       int64
	SrMatchID     int64
	Status        string
	PaytableID    *int64
	CoverageLevel *int
	ClockSeconds  *int
	ClockRunning  bool
	ClockPeriod   *int
	ClockReadAt   *time.Time
	PausedBy      *string
	Note          *string
	MatchStatus   string
	ScheduledAt   time.Time
	// IsDemo marks a looping recorded fixture (see engine/demo.go). Such a
	// game never polls Sportradar after its one archival fetch and never
	// ends, so most of the live path's lifecycle handling does not apply
	// to it.
	IsDemo bool
	// DemoEpoch anchors cycle 0 of the loop. NULL is tolerated (the driver
	// falls back to "now", i.e. the loop starts on first sight) so a row
	// hand-inserted without one still works.
	DemoEpoch *time.Time
}

const sqlSelectActiveGames = `
SELECT g.match_id, g.sr_match_id, g.status, g.paytable_id, g.coverage_level,
       g.clock_seconds, g.clock_running, g.clock_period, g.clock_read_at,
       g.paused_by::text, g.note, m.status, m.scheduled_at,
       g.is_demo, g.demo_epoch
  FROM slotzilla_games g
  JOIN matches m ON m.id = g.match_id
 WHERE g.status IN ('scheduled', 'live', 'paused')
 ORDER BY g.match_id`

// SelectActiveGames returns every game that is not yet ended or voided.
func (s *Store) SelectActiveGames(ctx context.Context) ([]Game, error) {
	rows, err := s.pool.Query(ctx, sqlSelectActiveGames)
	if err != nil {
		return nil, fmt.Errorf("select active games: %w", err)
	}
	defer rows.Close()
	var out []Game
	for rows.Next() {
		var g Game
		if err := rows.Scan(&g.MatchID, &g.SrMatchID, &g.Status, &g.PaytableID, &g.CoverageLevel,
			&g.ClockSeconds, &g.ClockRunning, &g.ClockPeriod, &g.ClockReadAt,
			&g.PausedBy, &g.Note, &g.MatchStatus, &g.ScheduledAt,
			&g.IsDemo, &g.DemoEpoch); err != nil {
			return nil, fmt.Errorf("scan game: %w", err)
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// ClockUpdate is what one successful fetch writes back to the game row.
type ClockUpdate struct {
	MatchID       int64
	Seconds       int
	Running       bool
	Period        *int
	ReadAt        time.Time
	FeedLagMs     int
	CoverageLevel *int
	LastEventAt   *time.Time
}

const sqlUpdateGameClock = `
UPDATE slotzilla_games
   SET clock_seconds = $2,
       clock_running = $3,
       clock_period = $4,
       clock_read_at = $5,
       feed_lag_ms = $6,
       coverage_level = COALESCE($7, coverage_level),
       last_event_at = GREATEST(last_event_at, $8),
       updated_at = now()
 WHERE match_id = $1`

func (s *Store) UpdateGameClock(ctx context.Context, u ClockUpdate) error {
	if _, err := s.pool.Exec(ctx, sqlUpdateGameClock, u.MatchID, u.Seconds, u.Running, u.Period, u.ReadAt, u.FeedLagMs, u.CoverageLevel, u.LastEventAt); err != nil {
		return fmt.Errorf("update game clock %d: %w", u.MatchID, err)
	}
	return nil
}

const sqlMarkGameLive = `
UPDATE slotzilla_games
   SET status = 'live', updated_at = now()
 WHERE match_id = $1 AND status = 'scheduled'`

// MarkGameLive moves a scheduled game to live once the match has tipped
// off. A paused, ended or voided row is untouched.
func (s *Store) MarkGameLive(ctx context.Context, matchID int64) (bool, error) {
	tag, err := s.pool.Exec(ctx, sqlMarkGameLive, matchID)
	if err != nil {
		return false, fmt.Errorf("mark game live %d: %w", matchID, err)
	}
	return tag.RowsAffected() == 1, nil
}

const sqlEndGame = `
UPDATE slotzilla_games
   SET status = 'ended', note = COALESCE($2, note), updated_at = now()
 WHERE match_id = $1 AND status IN ('scheduled', 'live', 'paused')`

// EndGame is the one transition allowed on a paused row.
func (s *Store) EndGame(ctx context.Context, matchID int64, note *string) (bool, error) {
	tag, err := s.pool.Exec(ctx, sqlEndGame, matchID, note)
	if err != nil {
		return false, fmt.Errorf("end game %d: %w", matchID, err)
	}
	return tag.RowsAffected() == 1, nil
}

// NoteFeedDark is the note a service-made pause carries; paused_by stays
// NULL, which is what tells it apart from an operator's pause.
const NoteFeedDark = "feed_dark"

const sqlPauseGameByService = `
UPDATE slotzilla_games
   SET status = 'paused', paused_by = NULL, paused_at = now(), note = $2, updated_at = now()
 WHERE match_id = $1 AND status = 'live'`

// PauseGameByService pauses a live game with a service note (feed dark).
func (s *Store) PauseGameByService(ctx context.Context, matchID int64, note string) (bool, error) {
	tag, err := s.pool.Exec(ctx, sqlPauseGameByService, matchID, note)
	if err != nil {
		return false, fmt.Errorf("pause game %d: %w", matchID, err)
	}
	return tag.RowsAffected() == 1, nil
}

const sqlResumeServicePause = `
UPDATE slotzilla_games
   SET status = 'live', paused_at = NULL, note = NULL, updated_at = now()
 WHERE match_id = $1 AND status = 'paused' AND paused_by IS NULL AND note = $2`

// ResumeServicePause reopens a game the SERVICE paused (paused_by NULL,
// matching note). An operator's pause has paused_by set and never
// matches, so the admin's decision is never overridden.
func (s *Store) ResumeServicePause(ctx context.Context, matchID int64, note string) (bool, error) {
	tag, err := s.pool.Exec(ctx, sqlResumeServicePause, matchID, note)
	if err != nil {
		return false, fmt.Errorf("resume game %d: %w", matchID, err)
	}
	return tag.RowsAffected() == 1, nil
}

const sqlVoidGame = `
UPDATE slotzilla_games
   SET status = 'voided', note = $2, updated_at = now()
 WHERE match_id = $1 AND status IN ('scheduled', 'live', 'paused')`

// VoidGame ends a game whose fixture was cancelled.
func (s *Store) VoidGame(ctx context.Context, matchID int64, note string) (bool, error) {
	tag, err := s.pool.Exec(ctx, sqlVoidGame, matchID, note)
	if err != nil {
		return false, fmt.Errorf("void game %d: %w", matchID, err)
	}
	return tag.RowsAffected() == 1, nil
}

func isNoRows(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}
