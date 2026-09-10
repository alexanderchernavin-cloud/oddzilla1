// The pure half of the engine: how stored events become windows, when a
// window is final, and what a spin settles to. Nothing here touches
// Postgres, Redis or the clock; engine.go supplies those.

package engine

import (
	"fmt"
	"strconv"
	"time"

	"github.com/oddzilla/slotzilla/internal/rules"
	"github.com/oddzilla/slotzilla/internal/store"
)

// Event is the engine's in-memory copy of one stored event.
type Event struct {
	ID       int64
	Symbol   rules.Symbol // "" = no symbol
	Team     string
	Seconds  int
	Disabled bool
	// SeenAt is when THIS version of the event reached us (insert or
	// correction). The grace period is measured from it: the scout's own
	// stamp lags wall clock by the feed delay, and a correction that
	// arrives 18 s late must still hold the window open for its grace.
	SeenAt time.Time
}

// Window is one 5-second window's derived reel.
type Window struct {
	From int
	Reel rules.Reel
	// LastUpdate is the latest SeenAt of any event inside the window,
	// disabled ones included (a correction that disables an event is
	// still a correction). Zero for an empty window.
	LastUpdate time.Time
}

// BuildWindows derives every window that holds at least one clocked
// event, keyed by window start. Windows with nothing in them are absent;
// WindowAt reads them as NONE.
func BuildWindows(events map[int64]Event) map[int]Window {
	groups := map[int][]rules.ReelEvent{}
	last := map[int]time.Time{}
	for _, e := range events {
		from := rules.WindowStartOf(e.Seconds)
		groups[from] = append(groups[from], rules.ReelEvent{
			Symbol:   e.Symbol,
			Seconds:  e.Seconds,
			Disabled: e.Disabled,
			Team:     e.Team,
			EventID:  strconv.FormatInt(e.ID, 10),
		})
		if e.SeenAt.After(last[from]) {
			last[from] = e.SeenAt
		}
	}
	out := make(map[int]Window, len(groups))
	for from, evs := range groups {
		out[from] = Window{From: from, Reel: rules.ReelForWindow(evs, from), LastUpdate: last[from]}
	}
	return out
}

// WindowAt returns the window for `from`, an empty NONE window when no
// event fell in it.
func WindowAt(ws map[int]Window, from int) Window {
	if w, ok := ws[from]; ok {
		return w
	}
	return Window{From: from, Reel: rules.Reel{Symbol: rules.NONE}}
}

// FinalRule carries the two operator knobs the `final` predicate reads.
type FinalRule struct {
	ClockPastSeconds int
	GraceSeconds     int
}

// WindowFinal reports whether a window's symbol can no longer change:
// the match clock is past the window by clock_past_seconds — dropped once
// the match has ended, because the clock will not move again and a
// window the clock did reach is complete — AND grace_seconds of wall time
// have passed since the last event inside it reached us. An empty window
// has no event to wait on and is final on the clock alone.
func WindowFinal(w Window, clockSeconds int, ended bool, now time.Time, rule FinalRule) bool {
	past := w.From + rules.WindowSeconds
	if !ended {
		past += rule.ClockPastSeconds
	}
	if clockSeconds < past {
		return false
	}
	if !w.LastUpdate.IsZero() && now.Sub(w.LastUpdate) < time.Duration(rule.GraceSeconds)*time.Second {
		return false
	}
	return true
}

// Outcome composes a spin's settlement from its three reels: the line
// they form, the multiplier the spin's OWN paytable gives that line (0
// when the line is absent or no line formed), and the floored payout.
// Status is 'won' when anything was paid, 'lost' otherwise.
func Outcome(reels [3]rules.Reel, lines rules.PaytableLines, stakeMicro int64) (store.Settlement, error) {
	st := store.Settlement{
		Reels: [3]rules.Symbol{reels[0].Symbol, reels[1].Symbol, reels[2].Symbol},
		Teams: [3]string{reels[0].Team, reels[1].Team, reels[2].Team},
	}
	for i, r := range reels {
		if r.EventID == "" {
			continue
		}
		id, err := strconv.ParseInt(r.EventID, 10, 64)
		if err != nil {
			return store.Settlement{}, fmt.Errorf("reel %d event id %q: %w", i, r.EventID, err)
		}
		st.EventIDs[i] = &id
	}
	if line, ok := rules.EvaluateLine(st.Reels); ok {
		st.LineKey = string(line)
		st.MultiplierX100 = lines[line]
	}
	payout, err := rules.PayoutMicro(stakeMicro, st.MultiplierX100)
	if err != nil {
		return store.Settlement{}, err
	}
	st.PayoutMicro = payout
	if payout > 0 {
		st.Status = "won"
	} else {
		st.Status = "lost"
	}
	return st, nil
}

// RecentWindowsCount is how many windows the state frame carries: the 90
// most recent seconds of match clock, which covers every spin a bettor
// can have open plus what just happened.
const RecentWindowsCount = 18

// RecentWindows lists the last RecentWindowsCount windows up to and
// including the one the clock is in, oldest first, never before 0.
func RecentWindows(ws map[int]Window, clockSeconds int) []Window {
	current := rules.WindowStartOf(clockSeconds)
	start := current - (RecentWindowsCount-1)*rules.WindowSeconds
	if start < 0 {
		start = 0
	}
	out := make([]Window, 0, RecentWindowsCount)
	for from := start; from <= current; from += rules.WindowSeconds {
		out = append(out, WindowAt(ws, from))
	}
	return out
}
