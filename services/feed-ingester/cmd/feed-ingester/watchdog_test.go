package main

import (
	"testing"
	"time"
)

func TestFeedSilence(t *testing.T) {
	boot := time.Date(2026, 5, 29, 18, 0, 0, 0, time.UTC)
	now := boot.Add(30 * time.Second)

	// A recent delivery: silence measured from that delivery, not boot.
	lastMsg := now.Add(-8 * time.Second).Unix()
	if got := feedSilence(lastMsg, now, boot); got != 8*time.Second {
		t.Fatalf("recent delivery: want 8s, got %v", got)
	}

	// No delivery yet (dead token at startup): silence measured from boot.
	if got := feedSilence(0, now, boot); got != 30*time.Second {
		t.Fatalf("no delivery yet: want 30s (since boot), got %v", got)
	}

	// Stale delivery far in the past: silence is the full elapsed window.
	stale := now.Add(-75 * time.Second).Unix()
	if got := feedSilence(stale, now, boot); got != 75*time.Second {
		t.Fatalf("stale delivery: want 75s, got %v", got)
	}
}

// TestFeedSilenceCrossesThreshold documents the watchdog's trip decision:
// silence >= threshold suspends, regardless of whether silence is measured
// from a prior delivery or from boot.
func TestFeedSilenceCrossesThreshold(t *testing.T) {
	boot := time.Date(2026, 5, 29, 18, 0, 0, 0, time.UTC)
	threshold := 20 * time.Second

	cases := []struct {
		name        string
		lastMsg     int64
		afterBoot   time.Duration
		wantSuspend bool
	}{
		{"healthy heartbeat", boot.Add(5 * time.Second).Unix(), 12 * time.Second, false},
		{"one missed beat", boot.Add(2 * time.Second).Unix(), 19 * time.Second, false},
		{"silent past threshold", boot.Add(2 * time.Second).Unix(), 25 * time.Second, true},
		{"dead token at boot", 0, 25 * time.Second, true},
		{"dead token within grace", 0, 15 * time.Second, false},
	}
	for _, c := range cases {
		now := boot.Add(c.afterBoot)
		stale := feedSilence(c.lastMsg, now, boot) >= threshold
		if stale != c.wantSuspend {
			t.Errorf("%s: want suspend=%v, got %v", c.name, c.wantSuspend, stale)
		}
	}
}
