package handler

import (
	"encoding/json"
	"time"

	"github.com/oddzilla/feed-ingester/internal/oddinxml"
)

// liveScorePayload is the JSON shape persisted to matches.live_score and
// returned verbatim by the API. The top-level `home`/`away` fields hold
// the series score (number of maps won) so existing list-card code that
// reads `liveScore.home` / `liveScore.away` keeps working unchanged.
//
// Per-map detail (rounds for CS2/Valorant, kills for Dota/LoL, etc.) is
// in `periods`; the live state of the in-progress map is in `scoreboard`.
// `currentMap` is 1-indexed and reflects which map is being played right
// now — derived from completed-period count or, when unavailable, from
// home+away map score.
type liveScorePayload struct {
	Home            *int               `json:"home,omitempty"`
	Away            *int               `json:"away,omitempty"`
	Status          *int               `json:"status,omitempty"`
	MatchStatusCode *int               `json:"matchStatusCode,omitempty"`
	CurrentMap      *int               `json:"currentMap,omitempty"`
	Scoreboard      *scoreboardPayload `json:"scoreboard,omitempty"`
	Periods         []periodPayload    `json:"periods,omitempty"`
	UpdatedAt       string             `json:"updatedAt"`
}

type scoreboardPayload struct {
	HomeWonRounds        *int   `json:"homeWonRounds,omitempty"`
	AwayWonRounds        *int   `json:"awayWonRounds,omitempty"`
	HomeKills            *int   `json:"homeKills,omitempty"`
	AwayKills            *int   `json:"awayKills,omitempty"`
	HomeDestroyedTurrets *int   `json:"homeDestroyedTurrets,omitempty"`
	AwayDestroyedTurrets *int   `json:"awayDestroyedTurrets,omitempty"`
	HomeDestroyedTowers  *int   `json:"homeDestroyedTowers,omitempty"`
	AwayDestroyedTowers  *int   `json:"awayDestroyedTowers,omitempty"`
	HomeGold             *int   `json:"homeGold,omitempty"`
	AwayGold             *int   `json:"awayGold,omitempty"`
	HomeGoals            *int   `json:"homeGoals,omitempty"`
	AwayGoals            *int   `json:"awayGoals,omitempty"`
	CurrentCtTeam        *int   `json:"currentCtTeam,omitempty"`
	CurrentDefTeam       *int   `json:"currentDefTeam,omitempty"`
	Time                 string `json:"time,omitempty"`
	GameTime             *int   `json:"gameTime,omitempty"`
	RemainingGameTime    *int   `json:"remainingGameTime,omitempty"`
}

type periodPayload struct {
	Number               *int   `json:"number,omitempty"`
	Type                 string `json:"type,omitempty"`
	MatchStatusCode      *int   `json:"matchStatusCode,omitempty"`
	HomeScore            *int   `json:"homeScore,omitempty"`
	AwayScore            *int   `json:"awayScore,omitempty"`
	HomeWonRounds        *int   `json:"homeWonRounds,omitempty"`
	AwayWonRounds        *int   `json:"awayWonRounds,omitempty"`
	HomeKills            *int   `json:"homeKills,omitempty"`
	AwayKills            *int   `json:"awayKills,omitempty"`
	HomeGoals            *int   `json:"homeGoals,omitempty"`
	AwayGoals            *int   `json:"awayGoals,omitempty"`
	HomeDestroyedTurrets *int   `json:"homeDestroyedTurrets,omitempty"`
	AwayDestroyedTurrets *int   `json:"awayDestroyedTurrets,omitempty"`
	HomeDestroyedTowers  *int   `json:"homeDestroyedTowers,omitempty"`
	AwayDestroyedTowers  *int   `json:"awayDestroyedTowers,omitempty"`
	IsLive               bool   `json:"isLive,omitempty"`
}

// buildLiveScore converts a decoded sport_event_status into the JSON
// payload we persist. Returns (nil, nil) when the block has nothing
// useful (no series score, no periods, no scoreboard) — caller should
// then leave matches.live_score as-is.
//
// `currentMap` heuristic:
//   - Prefer the highest period.number with match_status_code that maps
//     to "in progress" (Oddin uses 6 = live for CS2 maps).
//   - Otherwise: count completed periods + 1 (next map being played).
//   - Otherwise: home+away series score + 1 (e.g. 2-1 series → map 4).
//   - The match must be live; for closed matches the indicator is dropped.
func buildLiveScore(s *oddinxml.SportEventStatus, oddinTsMs int64) ([]byte, error) {
	if s == nil {
		return nil, nil
	}
	hasPeriods := s.PeriodScores != nil && len(s.PeriodScores.Periods) > 0
	hasScoreboard := s.Scoreboard != nil
	if s.HomeScore == nil && s.AwayScore == nil && !hasPeriods && !hasScoreboard {
		return nil, nil
	}

	payload := liveScorePayload{
		Home:            s.HomeScore,
		Away:            s.AwayScore,
		Status:          s.Status,
		MatchStatusCode: s.MatchStatus,
		UpdatedAt:       time.UnixMilli(oddinTsMs).UTC().Format(time.RFC3339Nano),
	}

	if hasScoreboard {
		sb := s.Scoreboard
		payload.Scoreboard = &scoreboardPayload{
			HomeWonRounds:        sb.HomeWonRounds,
			AwayWonRounds:        sb.AwayWonRounds,
			HomeKills:            sb.HomeKills,
			AwayKills:            sb.AwayKills,
			HomeDestroyedTurrets: sb.HomeDestroyedTurrets,
			AwayDestroyedTurrets: sb.AwayDestroyedTurrets,
			HomeDestroyedTowers:  sb.HomeDestroyedTowers,
			AwayDestroyedTowers:  sb.AwayDestroyedTowers,
			HomeGold:             sb.HomeGold,
			AwayGold:             sb.AwayGold,
			HomeGoals:            sb.HomeGoals,
			AwayGoals:            sb.AwayGoals,
			CurrentCtTeam:        sb.CurrentCtTeam,
			CurrentDefTeam:       sb.CurrentDefTeam,
			Time:                 sb.Time,
			GameTime:             sb.GameTime,
			RemainingGameTime:    sb.RemainingGameTime,
		}
	}

	if hasPeriods {
		periods := s.PeriodScores.Periods
		payload.Periods = make([]periodPayload, 0, len(periods))
		for _, p := range periods {
			payload.Periods = append(payload.Periods, periodPayload{
				Number:               p.Number,
				Type:                 p.Type,
				MatchStatusCode:      p.MatchStatusCode,
				HomeScore:            p.HomeScore,
				AwayScore:            p.AwayScore,
				HomeWonRounds:        p.HomeWonRounds,
				AwayWonRounds:        p.AwayWonRounds,
				HomeKills:            p.HomeKills,
				AwayKills:            p.AwayKills,
				HomeGoals:            p.HomeGoals,
				AwayGoals:            p.AwayGoals,
				HomeDestroyedTurrets: p.HomeDestroyedTurrets,
				AwayDestroyedTurrets: p.AwayDestroyedTurrets,
				HomeDestroyedTowers:  p.HomeDestroyedTowers,
				AwayDestroyedTowers:  p.AwayDestroyedTowers,
			})
		}
	}

	payload.CurrentMap = deriveCurrentMap(s)

	// Mark the live period so the frontend can highlight it without
	// re-deriving the index. A period is live when its number matches
	// `currentMap` AND the overall match is still running (status<3 in
	// UOF terms — anything ≥3 is ended/closed/cancelled).
	if payload.CurrentMap != nil && (s.Status == nil || *s.Status < 3) {
		for i := range payload.Periods {
			if payload.Periods[i].Number != nil && *payload.Periods[i].Number == *payload.CurrentMap {
				payload.Periods[i].IsLive = true
			}
		}
	}

	return json.Marshal(payload)
}

// deriveCurrentMap returns the 1-indexed period being played right now.
// "Map" is a CS2/Valorant term, but the field is generic — for basketball
// it's the current quarter, for football the current half, etc.
//
// Heuristic order:
//
//  1. The highest period flagged with the UOF "in progress" code 6.
//     Honored where Oddin uses it (some traditional sports do).
//  2. Count of periods that have a determined score, plus 1, capped at
//     the total period count. A period is "started/completed" when it
//     has any non-zero metric (score, rounds, kills, goals, etc.).
//
// We deliberately do NOT use top-level series home_score + away_score,
// since for non-map sports (basketball quarters, football halves) those
// fields hold cumulative game points, not maps-won — adding them
// produces nonsense like "currentMap = 74".
//
// Returns nil when the series has ended (status >= 3).
func deriveCurrentMap(s *oddinxml.SportEventStatus) *int {
	if s == nil {
		return nil
	}
	if s.Status != nil && *s.Status >= 3 {
		return nil
	}

	if s.PeriodScores == nil || len(s.PeriodScores.Periods) == 0 {
		return nil
	}

	var live int
	liveSet := false
	for _, p := range s.PeriodScores.Periods {
		if p.Number == nil || p.MatchStatusCode == nil || *p.MatchStatusCode != 6 {
			continue
		}
		if !liveSet || *p.Number > live {
			live = *p.Number
			liveSet = true
		}
	}
	if liveSet {
		n := live
		return &n
	}

	completed := 0
	maxNumber := 0
	for _, p := range s.PeriodScores.Periods {
		if p.Number != nil && *p.Number > maxNumber {
			maxNumber = *p.Number
		}
		if periodHasScore(p) {
			completed++
		}
	}
	n := completed + 1
	if maxNumber > 0 && n > maxNumber {
		n = maxNumber
	}
	return &n
}

// periodHasScore returns true when any score-bearing attribute on the
// period is non-zero. Used to decide whether the period has started.
func periodHasScore(p oddinxml.PeriodScore) bool {
	pairs := [][2]*int{
		{p.HomeScore, p.AwayScore},
		{p.HomeWonRounds, p.AwayWonRounds},
		{p.HomeKills, p.AwayKills},
		{p.HomeGoals, p.AwayGoals},
		{p.HomeDestroyedTurrets, p.AwayDestroyedTurrets},
		{p.HomeDestroyedTowers, p.AwayDestroyedTowers},
	}
	for _, pair := range pairs {
		h := 0
		a := 0
		if pair[0] != nil {
			h = *pair[0]
		}
		if pair[1] != nil {
			a = *pair[1]
		}
		if h+a > 0 {
			return true
		}
	}
	return false
}
