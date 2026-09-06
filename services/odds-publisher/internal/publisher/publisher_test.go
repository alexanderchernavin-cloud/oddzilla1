package publisher

import "testing"

func TestApplyMargin(t *testing.T) {
	cases := []struct {
		name     string
		raw      string
		marginBp int
		want     string
	}{
		// bp=0 passes Oddin's value through unchanged. Trailing zeros
		// beyond 2dp are trimmed, ≥2dp minimum preserved.
		{"no margin, round number", "2.00", 0, "2.00"},
		{"no margin, irrational", "1.85", 0, "1.85"},
		// With margin, the math runs at 4dp precision and the result is
		// then snapped DOWN onto the quote ladder — 0.01 below 10. The
		// 4dp intermediate ("1.9047") is arithmetic, not a price: no
		// book prints it, and until 2026-09-07 it reached the storefront
		// verbatim.
		{"5% margin on evens", "2.00", 500, "1.90"},
		{"5% margin on favorite", "1.50", 500, "1.42"},
		{"5% margin on dog", "3.00", 500, "2.85"},
		{"5% margin on user's screenshot (3.30)", "3.30", 500, "3.14"},
		{"5% margin on user's screenshot (1.28)", "1.28", 500, "1.21"},
		{"10% margin", "2.00", 1000, "1.81"},
		{"50% margin", "2.00", 5000, "1.33"},
		// Regression tests for float64 truncation: 1.01-1.03 used to
		// lose their last cent in a float64 round-trip; big.Float
		// end-to-end keeps these intact.
		{"no margin, 1.01", "1.01", 0, "1.01"},
		{"no margin, 1.02", "1.02", 0, "1.02"},
		{"no margin, 1.03", "1.03", 0, "1.03"},
		{"no margin, 1.10", "1.10", 0, "1.10"},
		// Below the 1.01 ladder floor Oddin's own precision survives
		// intact — there is no rung between an unbettable 1.00 and a
		// 1.01 longer than the feed said, so a genuine near-certain
		// favorite keeps every digit. This is the case the 4dp rule was
		// written for, and the ladder deliberately does not touch it.
		{"no margin, 1.003 preserves 3dp", "1.003", 0, "1.003"},
		{"no margin, exactly 1.00 passes through", "1.00", 0, "1.00"},
		{"no margin, 1.005 preserves 3dp", "1.005", 0, "1.005"},
		{"no margin, 1.0034 preserves 4dp", "1.0034", 0, "1.0034"},
		{"no margin, 0.99 passes through (no floor)", "0.99", 0, "0.99"},
		{"no margin, trailing zero on 3dp trimmed", "1.0300", 0, "1.03"},
		// 5% margin on a near-floor quote no longer clamps — displays
		// what the math produces. (Previously this clamped to 1.01.)
		// Still under the ladder floor, so still 4dp.
		{"5% margin on 1.003 (no floor)", "1.003", 500, "0.9552"},
		// At and above the floor the ladder takes over. Every one of
		// these came off a live CS2 map on 2026-09-06, where the book
		// shipped as 5.1410 / 3.6860 / 1.3095 / 1.1834.
		{"ladder, 4dp map-winner price", "5.1410", 0, "5.14"},
		{"ladder, 3dp map-winner price", "3.6860", 0, "3.68"},
		{"ladder, 4dp threeway favorite", "1.3095", 0, "1.30"},
		{"ladder, 4dp twoway favorite", "1.1834", 0, "1.18"},
		{"ladder, already on a rung", "9.7000", 0, "9.70"},
		{"ladder, exactly at the floor", "1.0100", 0, "1.01"},
		{"ladder, 4dp value with trailing zero", "1.50500", 0, "1.50"},
		// Tail bands: 0.1 to 20, 0.5 to 50, 1 to 100, then 5.
		{"ladder, 0.1 band", "13.4700", 0, "13.40"},
		{"ladder, 0.5 band", "23.7000", 0, "23.50"},
		{"ladder, 1.0 band", "76.4000", 0, "76.00"},
		{"ladder, 5.0 band", "163.0000", 0, "160.00"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := applyMargin(tc.raw, tc.marginBp)
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if got != tc.want {
				t.Fatalf("applyMargin(%q, %d) = %q, want %q", tc.raw, tc.marginBp, got, tc.want)
			}
		})
	}
}

func TestApplyMarginError(t *testing.T) {
	if _, err := applyMargin("", 500); err == nil {
		t.Fatal("expected error on empty input")
	}
	if _, err := applyMargin("not-a-number", 500); err == nil {
		t.Fatal("expected error on malformed input")
	}
}
