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
    -- A demo game must never stay ended: it is a loop, and 'ended' can
    -- only have come from machinery, not from an operator saying stop
    -- (that is 'voided', which is deliberately NOT revived here).
    -- Reached for real on 2026-09-10: the deploy applies migrations
    -- BEFORE it recreates services, so the demo rows existed for two
    -- minutes while the PREVIOUS binary was still running, and that
    -- binary had no demo path — it polled them as ordinary games, saw
    -- the archived timeline report the match ended, and ended them.
    -- Without this the demo was dead permanently and silently.
    --
    -- Precedence note: AND binds tighter than OR, so this reads as
    -- (status IN (...)) OR (is_demo AND status = 'ended'), which is what
    -- is meant — no parentheses needed around the IN list.
    OR (g.is_demo AND g.status = 'ended')
 ORDER BY g.match_id`

// SelectActiveGames returns every game the engine should still poll:
// anything not yet ended or voided, plus a demo game that was ended
// (see the note in the query — a loop has to be revivable).
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
	// The competition's period format, in seconds, when the feed states
	// it. Nil leaves whatever is stored alone — the format cannot change
	// mid-match, so one good reading is worth keeping over a later
	// document that happens to omit it.
	PeriodSeconds     *int
	OvertimeSeconds   *int
	RegulationPeriods *int
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
       period_seconds = COALESCE($9, period_seconds),
       overtime_seconds = COALESCE($10, overtime_seconds),
       regulation_periods = COALESCE($11, regulation_periods),
       updated_at = now()
 WHERE match_id = $1`

func (s *Store) UpdateGameClock(ctx context.Context, u ClockUpdate) error {
	if _, err := s.pool.Exec(ctx, sqlUpdateGameClock, u.MatchID, u.Seconds, u.Running, u.Period, u.ReadAt, u.FeedLagMs, u.CoverageLevel, u.LastEventAt,
		u.PeriodSeconds, u.OvertimeSeconds, u.RegulationPeriods); err != nil {
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

const sqlReviveDemoGame = `
UPDATE slotzilla_games
   SET status = 'live', note = NULL, updated_at = now()
 WHERE match_id = $1 AND is_demo AND status IN ('scheduled', 'ended')`

// ReviveDemoGame puts a demo game back on the loop. Scoped to `is_demo`
// so it can never resurrect a real fixture that has finished, and it
// leaves 'paused' and 'voided' alone: those are the operator's word, and
// the whole point of the pause and void controls is that they hold.
func (s *Store) ReviveDemoGame(ctx context.Context, matchID int64) (bool, error) {
	tag, err := s.pool.Exec(ctx, sqlReviveDemoGame, matchID)
	if err != nil {
		return false, fmt.Errorf("revive demo game %d: %w", matchID, err)
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
