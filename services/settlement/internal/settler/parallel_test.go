// parallel_test exercises the public surface of the worker-pool wiring
// added in the audit H6 follow-up: constructor clamping of the
// parallelism setting. The actual fan-out semantics (idempotency under
// crash, no deadlock, throughput) are exercised by the live test in
// tests/load/place-bets.js against a real postgres + Oddin AMQP feed —
// there's no in-process DB harness in this service.

package settler

import (
	"testing"

	"github.com/rs/zerolog"
)

func TestNewClampsParallelism(t *testing.T) {
	cases := []struct {
		name string
		in   int
		want int
	}{
		{"zero falls to 1", 0, 1},
		{"negative falls to 1", -3, 1},
		{"one stays one (fast path)", 1, 1},
		{"four stays four (default)", 4, 4},
		{"max stays max", settleMaxParallelism, settleMaxParallelism},
		{"above max clamps down", settleMaxParallelism + 5, settleMaxParallelism},
		{"way above max still clamps", 1000, settleMaxParallelism},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := New(nil, nil, 100, tc.in, zerolog.Nop())
			if s.parallelism != tc.want {
				t.Fatalf("parallelism: got %d, want %d (in=%d)", s.parallelism, tc.want, tc.in)
			}
		})
	}
}

// TestSettleTicketsInParallelEmpty verifies the helper short-circuits
// cleanly when there's nothing to settle — applyMarketSettle's phase 2
// path enters this with an empty slice when a market has no affected
// tickets (e.g. a settled outcome for which no one placed a bet).
func TestSettleTicketsInParallelEmpty(t *testing.T) {
	s := New(nil, nil, 100, 4, zerolog.Nop())
	got, err := s.settleTicketsInParallel(nil, nil)
	if err != nil {
		t.Fatalf("unexpected error on empty: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty result, got %d", len(got))
	}
	got, err = s.settleTicketsInParallel(nil, []string{})
	if err != nil {
		t.Fatalf("unexpected error on empty slice: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty result, got %d", len(got))
	}
}
