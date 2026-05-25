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
		// With margin, math runs at 4dp precision and trails are trimmed.
		// "1.42" (the old 2dp truncation) → "1.4285" now.
		{"5% margin on evens", "2.00", 500, "1.9047"},
		{"5% margin on favorite", "1.50", 500, "1.4285"},
		{"5% margin on dog", "3.00", 500, "2.8571"},
		{"5% margin on user's screenshot (3.30)", "3.30", 500, "3.1428"},
		{"5% margin on user's screenshot (1.28)", "1.28", 500, "1.219"},
		{"10% margin", "2.00", 1000, "1.8181"},
		{"50% margin", "2.00", 5000, "1.3333"},
		// Regression tests for float64 truncation: 1.01-1.03 used to
		// lose their last cent in a float64 round-trip; big.Float
		// end-to-end keeps these intact.
		{"no margin, 1.01", "1.01", 0, "1.01"},
		{"no margin, 1.02", "1.02", 0, "1.02"},
		{"no margin, 1.03", "1.03", 0, "1.03"},
		{"no margin, 1.10", "1.10", 0, "1.10"},
		// Display-what-Oddin-sends: no floor, full precision up to 4dp.
		{"no margin, 1.003 preserves 3dp", "1.003", 0, "1.003"},
		{"no margin, exactly 1.00 passes through", "1.00", 0, "1.00"},
		{"no margin, 1.005 preserves 3dp", "1.005", 0, "1.005"},
		{"no margin, 1.0034 preserves 4dp", "1.0034", 0, "1.0034"},
		{"no margin, 0.99 passes through (no floor)", "0.99", 0, "0.99"},
		{"no margin, trailing zero on 3dp trimmed", "1.0300", 0, "1.03"},
		{"no margin, 4dp value with trailing zero", "1.50500", 0, "1.505"},
		// 5% margin on a near-floor quote no longer clamps — displays
		// what the math produces. (Previously this clamped to 1.01.)
		{"5% margin on 1.003 (no floor)", "1.003", 500, "0.9552"},
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
