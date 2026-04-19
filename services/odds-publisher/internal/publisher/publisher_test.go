package publisher

import "testing"

func TestApplyMargin(t *testing.T) {
	cases := []struct {
		name     string
		raw      string
		marginBp int
		want     string
	}{
		{"no margin, round number", "2.00", 0, "2.00"},
		{"no margin, irrational", "1.85", 0, "1.85"},
		{"5% margin on evens", "2.00", 500, "1.90"},
		{"5% margin on favorite", "1.50", 500, "1.42"},
		{"5% margin on dog", "3.00", 500, "2.85"},
		{"5% margin on user's screenshot (3.30)", "3.30", 500, "3.14"},
		{"5% margin on user's screenshot (1.28)", "1.28", 500, "1.21"},
		{"10% margin", "2.00", 1000, "1.81"},
		{"50% margin (cap)", "2.00", 5000, "1.33"},
		// Regression tests for float64 truncation bug: 1.01-1.03 used to
		// lose their last cent because float64(1.02) = 1.0199999..., so
		// int64(1.02*100) = 101 → 1.01, and int64(1.01*100) = 100 → 1.00.
		// With big.Float end-to-end + a 1.01 floor, these must survive.
		{"no margin, 1.01 (previously truncated to 1.00)", "1.01", 0, "1.01"},
		{"no margin, 1.02 (previously truncated to 1.01)", "1.02", 0, "1.02"},
		{"no margin, 1.03", "1.03", 0, "1.03"},
		{"no margin, 1.10", "1.10", 0, "1.10"},
		// Floor clamp kicks in for any raw below 1.01.
		{"no margin, exactly 1.00 → clamp", "1.00", 0, "1.01"},
		{"no margin, 1.005 → clamp", "1.005", 0, "1.01"},
		{"5% margin pushing below floor → clamp", "1.02", 500, "1.01"},
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
