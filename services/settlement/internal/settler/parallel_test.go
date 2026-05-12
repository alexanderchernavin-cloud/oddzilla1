// parallel_test exercises the public surface of the worker-pool wiring
// added in the audit H6 follow-up: constructor clamping of the
// parallelism setting. The actual fan-out semantics (idempotency under
// crash, no deadlock, throughput) are exercised by the live test in
// tests/load/place-bets.js against a real postgres + Oddin AMQP feed —
// there's no in-process DB harness in this service.

package settler

import (
	"fmt"
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

// TestPartitionByUserID exercises the FNV-32 partitioning that prevents
// the cross-worker wallet deadlock PR #273 originally shipped with.
//
// The invariant we guard is: for every parallelism setting, every user's
// tickets must land in EXACTLY ONE partition. If any user's tickets
// spread across multiple partitions, two workers can race for the same
// wallet row → deadlock under load.
//
// We don't test the settle path itself here (no in-process DB harness);
// the live load test at 100K tickets in a single market is the
// integration test that catches regressions.
func TestPartitionByUserID(t *testing.T) {
	// Replicates the loop in settleTicketsInParallel — keep this in
	// sync if that path changes.
	partition := func(tickets []string, userMap map[string]string, parallelism int) [][]string {
		parts := make([][]string, parallelism)
		for _, tid := range tickets {
			uid, ok := userMap[tid]
			var idx int
			if ok {
				idx = int(fnv32(uid) % uint32(parallelism))
			}
			parts[idx] = append(parts[idx], tid)
		}
		return parts
	}

	cases := []struct {
		name        string
		users       int
		ticketsPer  int
		parallelism int
	}{
		{"100 users × 10 tickets, 4 workers", 100, 10, 4},
		{"250 users × 400 tickets, 8 workers (100K scale)", 250, 400, 8},
		{"single user, all tickets in one partition", 1, 50, 4},
		{"parallelism=2", 50, 20, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tickets := make([]string, 0, tc.users*tc.ticketsPer)
			userMap := make(map[string]string, tc.users*tc.ticketsPer)
			for u := 0; u < tc.users; u++ {
				uid := fmt.Sprintf("user-%04d", u)
				for k := 0; k < tc.ticketsPer; k++ {
					tid := fmt.Sprintf("ticket-%04d-%04d", u, k)
					tickets = append(tickets, tid)
					userMap[tid] = uid
				}
			}
			parts := partition(tickets, userMap, tc.parallelism)

			// Invariant: each user's tickets all in the same partition.
			userPartition := make(map[string]int)
			for partIdx, part := range parts {
				for _, tid := range part {
					uid := userMap[tid]
					if existing, seen := userPartition[uid]; seen && existing != partIdx {
						t.Fatalf("user %s tickets split: partition %d AND partition %d", uid, existing, partIdx)
					}
					userPartition[uid] = partIdx
				}
			}

			// Sanity: total tickets preserved.
			total := 0
			for _, part := range parts {
				total += len(part)
			}
			if total != len(tickets) {
				t.Fatalf("ticket count drift: got %d, want %d", total, len(tickets))
			}

			// Reasonable load balance — no partition more than 3× the
			// average (FNV-32 with hundreds of users gives much better
			// than this in practice; 3× is the runaway-skew alarm).
			// Only check when there are enough distinct users to
			// distribute across all workers — a single-user load
			// CORRECTLY lands all tickets in one partition.
			if tc.users >= tc.parallelism*4 {
				avg := float64(total) / float64(tc.parallelism)
				for partIdx, part := range parts {
					if avg > 0 && float64(len(part)) > 3*avg {
						t.Fatalf("partition %d severely imbalanced: %d tickets (avg %.1f)",
							partIdx, len(part), avg)
					}
				}
			}
		})
	}
}

// TestFnv32Stable confirms FNV-1a is deterministic — the deadlock fix
// relies on "same user always hashes to same worker" across runs,
// retries, and the AMQP redelivery path.
func TestFnv32Stable(t *testing.T) {
	inputs := []string{"", "a", "user-0001", "00000000-0000-0000-0000-000000000000"}
	for _, in := range inputs {
		first := fnv32(in)
		for i := 0; i < 10; i++ {
			if got := fnv32(in); got != first {
				t.Fatalf("fnv32(%q) not stable: got %d, want %d", in, got, first)
			}
		}
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
