package products

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

type tipleCase struct {
	Name            string   `json:"name"`
	Probabilities   []string `json:"probabilities"`
	MarginBp        int      `json:"marginBp"`
	OfferedOdds     string   `json:"offeredOdds"`
	FairProbability float64  `json:"fairProbability"`
}

type tippotCaseTier struct {
	K          int    `json:"k"`
	PAtLeastK  string `json:"pAtLeastK"`
	Multiplier string `json:"multiplier"`
}

type tippotCase struct {
	Name          string           `json:"name"`
	Probabilities []string         `json:"probabilities"`
	MarginBp      int              `json:"marginBp"`
	Tiers         []tippotCaseTier `json:"tiers"`
}

type fixture struct {
	Tiple  []tipleCase  `json:"tiple"`
	Tippot []tippotCase `json:"tippot"`
}

func loadFixture(t *testing.T) fixture {
	t.Helper()
	// services/settlement/internal/products → ../../../../docs/fixtures/products.json
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	path := filepath.Join(wd, "..", "..", "..", "..", "docs", "fixtures", "products.json")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture %s: %v", path, err)
	}
	var f fixture
	if err := json.Unmarshal(body, &f); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	return f
}

func parseProbs(t *testing.T, in []string) []float64 {
	t.Helper()
	out := make([]float64, len(in))
	for i, s := range in {
		p, err := ParseProbability(s)
		if err != nil {
			t.Fatalf("parse %s: %v", s, err)
		}
		out[i] = p
	}
	return out
}

func TestTipleGoldenFixture(t *testing.T) {
	f := loadFixture(t)
	for _, tc := range f.Tiple {
		t.Run(tc.Name, func(t *testing.T) {
			probs := parseProbs(t, tc.Probabilities)
			q, err := PriceTiple(probs, tc.MarginBp)
			if err != nil {
				t.Fatalf("price: %v", err)
			}
			if q.OfferedOdds != tc.OfferedOdds {
				t.Errorf("offeredOdds: got %s want %s", q.OfferedOdds, tc.OfferedOdds)
			}
			if math.Abs(q.FairProbability-tc.FairProbability) > 1e-9 {
				t.Errorf("fairProbability: got %v want %v", q.FairProbability, tc.FairProbability)
			}
		})
	}
}

func TestTippotGoldenFixture(t *testing.T) {
	f := loadFixture(t)
	for _, tc := range f.Tippot {
		t.Run(tc.Name, func(t *testing.T) {
			probs := parseProbs(t, tc.Probabilities)
			q, err := PriceTippot(probs, tc.MarginBp)
			if err != nil {
				t.Fatalf("price: %v", err)
			}
			if len(q.Tiers) != len(tc.Tiers) {
				t.Fatalf("tier count: got %d want %d", len(q.Tiers), len(tc.Tiers))
			}
			for i := range tc.Tiers {
				got, want := q.Tiers[i], tc.Tiers[i]
				if got.K != want.K {
					t.Errorf("tier[%d].k: got %d want %d", i, got.K, want.K)
				}
				if got.PAtLeastK != want.PAtLeastK {
					t.Errorf("tier[%d].pAtLeastK: got %s want %s", i, got.PAtLeastK, want.PAtLeastK)
				}
				if got.Multiplier != want.Multiplier {
					t.Errorf("tier[%d].multiplier: got %s want %s", i, got.Multiplier, want.Multiplier)
				}
			}
		})
	}
}

func TestTippotMultiplierStrictlyIncreasing(t *testing.T) {
	cases := []struct {
		probs []float64
		bp    int
	}{
		{[]float64{0.1, 0.2, 0.3, 0.4, 0.5}, 1500},
		{[]float64{0.5, 0.5, 0.5}, 1500},
		{[]float64{0.05, 0.1, 0.15, 0.2, 0.25, 0.3}, 0},
		{[]float64{0.9, 0.9, 0.9, 0.9}, 1500},
	}
	for _, c := range cases {
		q, err := PriceTippot(c.probs, c.bp)
		if err != nil {
			t.Fatalf("price: %v", err)
		}
		prev := math.Inf(-1)
		for _, tier := range q.Tiers {
			m, err := strconv.ParseFloat(tier.Multiplier, 64)
			if err != nil {
				t.Fatalf("parse %s: %v", tier.Multiplier, err)
			}
			if !(m > prev) {
				t.Errorf("multiplier should strictly increase: prev=%v m=%v", prev, m)
			}
			prev = m
		}
	}
}

func TestRejectsBadInputs(t *testing.T) {
	if _, err := PriceTiple([]float64{0.5, 1.0}, 1500); err == nil {
		t.Error("expected error for prob=1.0")
	}
	if _, err := PriceTiple([]float64{0.5}, 1500); err == nil {
		t.Error("expected error for too few legs")
	}
	if _, err := PriceTiple([]float64{0.5, 0.5}, -1); err == nil {
		t.Error("expected error for negative margin")
	}
	if _, err := PriceTippot([]float64{0.5, -0.1}, 1500); err == nil {
		t.Error("expected error for negative prob")
	}
}
