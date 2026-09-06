package worker

import "testing"

// The slip captures a laddered price from the catalog endpoint, and this
// worker re-derives the price during drift evaluation. If the two
// formatters disagree the worker compares against an off-rung value and
// rejects the bet for drift that never happened — so this pins the ladder
// against packages/types/src/odds.ts and the odds-publisher port.
func TestFormatOddsTrimQuotesOnLadder(t *testing.T) {
	cases := []struct {
		name string
		in   float64
		want string
	}{
		// Below the 1.01 floor the ladder has no rung to offer: 1.00 is
		// unbettable and 1.01 is longer than the feed said. Oddin's own
		// precision survives, which is the half of the range the 4dp
		// rule was written for.
		{"near-certain favorite keeps 3dp", 1.001, "1.001"},
		{"1.003 keeps 3dp", 1.003, "1.003"},
		{"4dp under the floor", 1.0034, "1.0034"},
		{"exactly 1.00", 1.0, "1.00"},
		// At and above the floor, 0.01 rungs up to 10.
		{"exactly at the floor", 1.01, "1.01"},
		{"live map-winner price", 5.141, "5.14"},
		{"live map-winner dog", 3.686, "3.68"},
		{"threeway favorite", 1.3095, "1.30"},
		{"already on a rung", 9.7, "9.70"},
		// Tail bands.
		{"0.1 band", 13.47, "13.40"},
		{"0.5 band", 23.7, "23.50"},
		{"1.0 band", 76.4, "76.00"},
		{"5.0 band", 163, "160.00"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := formatOddsTrim(tc.in); got != tc.want {
				t.Fatalf("formatOddsTrim(%v) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// A second pass must be a no-op: the publisher ladders before storing and
// every reader ladders again.
func TestLadderUnitsIdempotent(t *testing.T) {
	for units := int64(1); units <= 2_000_000; units += 89 {
		once := ladderUnits(units)
		if twice := ladderUnits(once); twice != once {
			t.Fatalf("ladderUnits not idempotent at %d: %d then %d", units, once, twice)
		}
		if once > units {
			t.Fatalf("ladderUnits raised the price at %d: got %d", units, once)
		}
	}
}
