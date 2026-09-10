package engine

import (
	"testing"
	"time"
)

var demoEpoch = time.Date(2026, 9, 10, 0, 0, 0, 0, time.UTC)

// The recording used by the shipped demo games is 2400 seconds, so the
// cycle is 2400 + demoCooldownSeconds.
const testDuration = 2400

func at(offset time.Duration) demoPhase {
	return demoPhaseAt(demoEpoch, demoEpoch.Add(offset), testDuration)
}

func TestDemoPhaseActiveWindow(t *testing.T) {
	cases := []struct {
		name    string
		offset  time.Duration
		seconds int
		running bool
		ended   bool
		index   int64
	}{
		{"tip-off", 0, 0, true, false, 0},
		{"mid-first-quarter", 5 * time.Minute, 300, true, false, 0},
		{"last second of the recording", 2399 * time.Second, 2399, true, false, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := at(tc.offset)
			if got.Seconds != tc.seconds || got.Running != tc.running ||
				got.Ended != tc.ended || got.Index != tc.index {
				t.Fatalf("got %+v, want seconds=%d running=%v ended=%v index=%d",
					got, tc.seconds, tc.running, tc.ended, tc.index)
			}
		})
	}
}

// The cooldown is what lets a spin placed on the closing seconds settle
// through the ordinary path: the clock stops and Ended drops
// WindowFinal's clock_past allowance, so every window the recording
// reached becomes final before the loop wraps.
func TestDemoPhaseCooldownStopsTheClockAndEndsTheGame(t *testing.T) {
	got := at(testDuration * time.Second)
	if got.Seconds != testDuration {
		t.Fatalf("cooldown clock = %d, want it parked at the recording's end %d", got.Seconds, testDuration)
	}
	if got.Running {
		t.Fatal("cooldown must stop the clock, otherwise spins stay placeable against a match that is over")
	}
	if !got.Ended {
		t.Fatal("cooldown must report Ended so open windows finalise")
	}
	if got.Index != 0 {
		t.Fatalf("cooldown belongs to the cycle that just finished, got index %d", got.Index)
	}
}

func TestDemoPhaseWrapsToTheNextCycle(t *testing.T) {
	cycle := time.Duration(testDuration+demoCooldownSeconds) * time.Second

	last := at(cycle - time.Second)
	if last.Index != 0 {
		t.Fatalf("still cycle 0 one second before the wrap, got %d", last.Index)
	}
	first := at(cycle)
	if first.Index != 1 {
		t.Fatalf("wrap must advance the cycle index, got %d", first.Index)
	}
	if first.Seconds != 0 || !first.Running || first.Ended {
		t.Fatalf("a new cycle restarts at tip-off, got %+v", first)
	}

	// Days later the loop is still on the same grid — the arithmetic is
	// modular, not a counter that could drift.
	later := at(cycle*137 + 300*time.Second)
	if later.Index != 137 || later.Seconds != 300 {
		t.Fatalf("got index=%d seconds=%d, want 137 / 300", later.Index, later.Seconds)
	}
}

// A demo_epoch in the future is reachable by an operator editing the row
// or by clock skew. Go's % keeps the sign of the dividend, so the naive
// form yields a negative second and indexes backwards through the
// recording — serving no events at all.
func TestDemoPhaseHandlesAnEpochInTheFuture(t *testing.T) {
	// 30 s before the epoch wraps to 2460 s into the PREVIOUS cycle, which
	// is inside that cycle's cooldown — so the clock parks at the end of
	// the recording rather than going negative.
	got := demoPhaseAt(demoEpoch, demoEpoch.Add(-30*time.Second), testDuration)
	if got.Seconds < 0 {
		t.Fatalf("negative clock %d from a future epoch", got.Seconds)
	}
	if got.Seconds != testDuration || got.Running || !got.Ended {
		t.Fatalf("got %+v, want the previous cycle's cooldown", got)
	}
	if got.Index != -1 {
		t.Fatalf("got index %d, want -1", got.Index)
	}

	// One well inside the active phase of the previous cycle, to pin that
	// the wrap-around reading itself is right and not just clamped.
	mid := demoPhaseAt(demoEpoch, demoEpoch.Add(-2190*time.Second), testDuration)
	if mid.Seconds != 300 || !mid.Running || mid.Index != -1 {
		t.Fatalf("got %+v, want seconds=300 running index=-1", mid)
	}
}

// A recording with no clocked events must not divide by zero.
func TestDemoPhaseFallsBackOnAnEmptyRecording(t *testing.T) {
	got := demoPhaseAt(demoEpoch, demoEpoch.Add(time.Minute), 0)
	if got.Seconds != 60 || !got.Running {
		t.Fatalf("got %+v, want the fallback duration to keep the loop running", got)
	}
}

func TestPeriodForClampsToFourQuarters(t *testing.T) {
	cases := map[int]int{0: 1, 599: 1, 600: 2, 1200: 3, 1800: 4, 2399: 4, 2700: 4}
	for seconds, want := range cases {
		if got := periodFor(seconds, testDuration); got == nil || *got != want {
			t.Fatalf("periodFor(%d) = %v, want %d", seconds, got, want)
		}
	}
}
