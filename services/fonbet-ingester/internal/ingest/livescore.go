package ingest

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/oddzilla/fonbet-ingester/internal/mapper"
)

// liveScorePayload mirrors feed-ingester's matches.live_score shape: the
// storefront list cards read `home` / `away`, the match page reads
// `periods`. `status` uses the Oddin lifecycle codes (1 = live).
type liveScorePayload struct {
	Home   *int `json:"home,omitempty"`
	Away   *int `json:"away,omitempty"`
	Status int  `json:"status"`
	// Clock is the match clock as an anchor the storefront runs itself:
	// see clockPayload. It replaced `scoreboard.time` on 2026-09-07,
	// which carried Fonbet's rendered "42:16" string and therefore
	// changed on every 5 s poll for every running match — a live_score
	// write plus a WS frame per match per poll, and a clock on the
	// storefront that still only moved when a frame landed.
	Clock *clockPayload `json:"clock,omitempty"`
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

// clockPayload is the match clock in the form the storefront extrapolates
// from: at unix-ms instant `atMs` the clock read `seconds`, and it has
// moved `direction` (1 up / 0 stopped / -1 down) seconds per second since.
//
// A RUNNING clock is stored normalised to its zero instant — `seconds` 0
// and `atMs` = the moment the clock read 0 — because that representation
// is constant for as long as the clock runs. Fonbet restates the reading
// at every packet time, so the raw (seconds, at) pair changes on every
// poll while describing the same clock; normalising it is what keeps a
// football half to one write at kick-off instead of one every 5 s, and
// it is why the storefront can run the clock for the whole half from a
// single frame. A STOPPED clock keeps its reading in `seconds` with no
// `atMs`, since the instant is irrelevant to a value that is not moving.
type clockPayload struct {
	Seconds   int   `json:"seconds"`
	Direction int   `json:"direction"`
	AtMs      int64 `json:"atMs,omitempty"`
}

// clockAnchorToleranceMs is how far Fonbet's implied zero instant may
// wander before we re-anchor. `timerSeconds` is an integer floor and the
// packet time has its own jitter, so consecutive polls of an undisturbed
// clock place the zero within about ±0.6 s of each other (measured across
// ~50 matches, 2026-09-07); anything inside 2 s is that noise and
// rewriting for it would recreate the per-poll churn. Anything beyond it
// is Fonbet moving the clock — a supplier correction, added time being
// applied — and the storefront should follow within one poll.
const clockAnchorToleranceMs = 2000

// normalizeClock turns a mapper.Clock observation into the stored form,
// reusing the previous anchor when the new observation is within
// tolerance of it. `nowMs` stands in for a missing timestamp on a
// running clock (lagging the truth by at most one poll).
func normalizeClock(c *mapper.Clock, nowMs int64, prev *clockPayload) *clockPayload {
	if c == nil {
		return nil
	}
	if c.Direction == 0 {
		return &clockPayload{Seconds: c.Seconds, Direction: 0}
	}
	at := c.AtMs
	if at <= 0 {
		at = nowMs
	}
	// Solve `0 = seconds + direction × (zero − at) / 1000` for zero.
	zeroAt := at - int64(c.Direction)*int64(c.Seconds)*1000
	if prev != nil && prev.Direction == c.Direction && prev.Seconds == 0 && prev.AtMs > 0 {
		if d := prev.AtMs - zeroAt; d >= -clockAnchorToleranceMs && d <= clockAnchorToleranceMs {
			zeroAt = prev.AtMs
		}
	}
	return &clockPayload{Seconds: 0, Direction: c.Direction, AtMs: zeroAt}
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
// nothing to show. `prevClock` is the clock the previous payload carried
// (nil when none), so a running clock keeps its anchor across polls.
// Returns the clock it embedded alongside the bytes, for the caller to
// hand back on the next cycle.
func buildLiveScore(m *mapper.Match, nowMs int64, prevClock *clockPayload) ([]byte, *clockPayload) {
	if m.Score == nil {
		return nil, nil
	}
	p := liveScorePayload{
		Home:      m.Score.Home,
		Away:      m.Score.Away,
		Status:    1,
		Clock:     normalizeClock(m.Score.Clock, nowMs, prevClock),
		Comment:   m.Score.Comment,
		Serve:     m.Score.Serve,
		Provider:  "fonbet",
		UpdatedAt: time.UnixMilli(nowMs).UTC().Format(time.RFC3339),
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
		return nil, nil
	}
	return out, p.Clock
}
