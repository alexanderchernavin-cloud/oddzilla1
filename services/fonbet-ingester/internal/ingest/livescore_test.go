package ingest

import (
	"encoding/json"
	"testing"

	"github.com/oddzilla/fonbet-ingester/internal/mapper"
)

// A running clock is stored at its zero instant, which is constant while
// the clock runs. Readings from consecutive polls that place that instant
// within tolerance of the previous one keep the previous anchor, so the
// payload — and therefore the live_score write and the WS frame — does
// not change from poll to poll for a clock that is simply running.
func TestNormalizeClockRunningIsSticky(t *testing.T) {
	// Poll 1: 42:16 at packet time T. Zero instant = T − 2536 s.
	first := normalizeClock(&mapper.Clock{Seconds: 2536, Direction: 1, AtMs: 1788795885113}, 0, nil)
	if first == nil || first.Seconds != 0 || first.Direction != 1 || first.AtMs != 1788795885113-2536_000 {
		t.Fatalf("first = %+v", first)
	}
	// Poll 2, five seconds later: 42:21 — but timerSeconds is an integer
	// floor and the packet time has its own jitter, so the implied zero
	// lands ~600 ms off. That is noise, not a clock change.
	second := normalizeClock(&mapper.Clock{Seconds: 2541, Direction: 1, AtMs: 1788795885113 + 5_612}, 0, first)
	if second.AtMs != first.AtMs {
		t.Fatalf("anchor moved on jitter: %d -> %d", first.AtMs, second.AtMs)
	}
	// Poll 3: Fonbet re-set the clock by four seconds. Follow it.
	third := normalizeClock(&mapper.Clock{Seconds: 2550, Direction: 1, AtMs: 1788795885113 + 10_000}, 0, second)
	if third.AtMs == second.AtMs {
		t.Fatalf("anchor did not follow a %ds correction", 4)
	}
	if want := int64(1788795885113 + 10_000 - 2550_000); third.AtMs != want {
		t.Fatalf("third.AtMs = %d, want %d", third.AtMs, want)
	}
}

func TestNormalizeClockStoppedAndRestarted(t *testing.T) {
	running := normalizeClock(&mapper.Clock{Seconds: 2690, Direction: 1, AtMs: 1_000_000_000_000}, 0, nil)
	// Half time: Fonbet sends the reading with direction 0 and no
	// timestamp. The stored form is the reading itself.
	stopped := normalizeClock(&mapper.Clock{Seconds: 2700, Direction: 0}, 0, running)
	if stopped == nil || *stopped != (clockPayload{Seconds: 2700, Direction: 0, AtMs: 0}) {
		t.Fatalf("stopped = %+v", stopped)
	}
	// Second half: a fresh zero instant, not reconciled with the stopped
	// value (different shape) nor with the first half's anchor.
	restarted := normalizeClock(&mapper.Clock{Seconds: 2703, Direction: 1, AtMs: 1_000_900_000_000}, 0, stopped)
	if restarted.Seconds != 0 || restarted.Direction != 1 || restarted.AtMs != 1_000_900_000_000-2703_000 {
		t.Fatalf("restarted = %+v", restarted)
	}
}

func TestNormalizeClockDirectionChangeReanchors(t *testing.T) {
	up := normalizeClock(&mapper.Clock{Seconds: 100, Direction: 1, AtMs: 5_000_000}, 0, nil)
	// A count-down clock reading 100 at the same instant reaches zero
	// 100 s LATER, not earlier — the sign of the anchor offset flips
	// with the direction.
	down := normalizeClock(&mapper.Clock{Seconds: 100, Direction: -1, AtMs: 5_000_000}, 0, up)
	if down.Direction != -1 || down.AtMs != 5_000_000+100_000 {
		t.Fatalf("down = %+v", down)
	}
}

func TestNormalizeClockMissingInstantUsesReceiptTime(t *testing.T) {
	got := normalizeClock(&mapper.Clock{Seconds: 60, Direction: 1, AtMs: 0}, 7_000_000, nil)
	if got.AtMs != 7_000_000-60_000 {
		t.Fatalf("AtMs = %d, want receipt time minus the reading", got.AtMs)
	}
	if normalizeClock(nil, 7_000_000, nil) != nil {
		t.Fatalf("nil clock must stay nil")
	}
}

// The payload diff in applyMatch strips only `updatedAt`, so everything
// else must be byte-identical between two polls of a running clock for
// the write to be skipped. This pins that the clock lands in the stored
// form and that a second poll reproduces the same bytes.
func TestBuildLiveScoreClockIsStableAcrossPolls(t *testing.T) {
	home, away := 0, 1
	m := &mapper.Match{Score: &mapper.LiveScore{
		Home: &home, Away: &away, Timer: "42:16",
		Clock: &mapper.Clock{Seconds: 2536, Direction: 1, AtMs: 1788795885113},
	}}
	first, clock := buildLiveScore(m, 1788795886000, nil)
	if first == nil || clock == nil {
		t.Fatalf("no payload")
	}
	var decoded struct {
		Clock *clockPayload `json:"clock"`
		Sb    *struct{}     `json:"scoreboard"`
	}
	if err := json.Unmarshal(first, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Clock == nil || *decoded.Clock != *clock {
		t.Fatalf("payload clock = %+v, returned %+v", decoded.Clock, clock)
	}
	if decoded.Sb != nil {
		t.Fatalf("scoreboard.time must no longer be written for Fonbet rows")
	}
	m.Score.Timer = "42:21"
	m.Score.Clock = &mapper.Clock{Seconds: 2541, Direction: 1, AtMs: 1788795885113 + 5_400}
	second, _ := buildLiveScore(m, 1788795891000, clock)
	if stripUpdatedAt(string(first)) != stripUpdatedAt(string(second)) {
		t.Fatalf("running clock changed the payload:\n%s\n%s", first, second)
	}
}
