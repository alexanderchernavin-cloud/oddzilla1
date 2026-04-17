package publisher

import "testing"

func TestApplyMargin(t *testing.T) {
	cases := []struct {
		name     string
		raw      string
		marginBp int
		want     string
	}{
		{"no margin, round number", "2.00", 0, "2.0000"},
		{"no margin, irrational", "1.85", 0, "1.8500"},
		{"5% margin on evens", "2.00", 500, "1.9048"},
		{"5% margin on favorite", "1.50", 500, "1.4286"},
		{"5% margin on dog", "3.00", 500, "2.8571"},
		{"10% margin", "2.00", 1000, "1.8182"},
		{"50% margin (cap)", "2.00", 5000, "1.3333"},
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
