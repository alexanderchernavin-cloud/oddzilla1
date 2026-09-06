package ingest

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/oddzilla/fonbet-ingester/internal/mapper"
)

// liveScorePayload mirrors feed-ingester's matches.live_score shape: the
// storefront list cards read `home` / `away`, the match page reads
// `periods` + `scoreboard`. `status` uses the Oddin lifecycle codes
// (1 = live).
type liveScorePayload struct {
	Home       *int               `json:"home,omitempty"`
	Away       *int               `json:"away,omitempty"`
	Status     int                `json:"status"`
	Scoreboard *scoreboardPayload `json:"scoreboard,omitempty"`
	// Side holding serve: 1 = home, 2 = away. Omitted for the sports
	// that have no such thing, which is most of them. Feeds the serve
	// marker on the storefront's tennis / table tennis / volleyball
	// rows; a change here is a live_score diff, so it publishes on the
	// same channel as a score change.
	Serve     int             `json:"serve,omitempty"`
	Periods   []periodPayload `json:"periods,omitempty"`
	Comment   string          `json:"comment,omitempty"`
	Provider  string          `json:"provider"`
	UpdatedAt string          `json:"updatedAt"`
}

type scoreboardPayload struct {
	Time string `json:"time,omitempty"`
}

type periodPayload struct {
	Number    int    `json:"number"`
	Type      string `json:"type,omitempty"`
	HomeScore *int   `json:"homeScore,omitempty"`
	AwayScore *int   `json:"awayScore,omitempty"`
	HomeText  string `json:"homeText,omitempty"`
	AwayText  string `json:"awayText,omitempty"`
}

// buildLiveScore renders the payload for a live match; nil when there is
// nothing to show.
func buildLiveScore(m *mapper.Match, nowMs int64) []byte {
	if m.Score == nil {
		return nil
	}
	p := liveScorePayload{
		Home:      m.Score.Home,
		Away:      m.Score.Away,
		Status:    1,
		Comment:   m.Score.Comment,
		Serve:     m.Score.Serve,
		Provider:  "fonbet",
		UpdatedAt: time.UnixMilli(nowMs).UTC().Format(time.RFC3339),
	}
	if m.Score.Timer != "" {
		p.Scoreboard = &scoreboardPayload{Time: m.Score.Timer}
	}
	for _, per := range m.Score.Periods {
		pp := periodPayload{Number: per.Number, Type: per.Title}
		if h, err := strconv.Atoi(per.Home); err == nil {
			pp.HomeScore = &h
		} else {
			pp.HomeText = per.Home
		}
		if a, err := strconv.Atoi(per.Away); err == nil {
			pp.AwayScore = &a
		} else {
			pp.AwayText = per.Away
		}
		p.Periods = append(p.Periods, pp)
	}
	out, err := json.Marshal(p)
	if err != nil {
		return nil
	}
	return out
}
