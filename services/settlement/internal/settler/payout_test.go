package settler

import (
	"testing"
)

func TestEffectiveFactor(t *testing.T) {
	cases := []struct {
		name       string
		odds       string
		result     string
		voidFactor string
		want       float64
	}{
		{"won, no void", "2.00", "won", "", 2.0},
		{"lost, no void", "2.00", "lost", "", 0.0},
		{"full void via result", "2.00", "void", "", 1.0},
		{"full void via void_factor=1 on lost", "2.00", "lost", "1", 1.0},
		{"half_won", "2.00", "half_won", "", 1.5},       // (1-0.5)*(1*2) + 0.5 = 1 + 0.5 = 1.5
		{"half_lost", "2.00", "half_lost", "", 0.5},     // (1-0.5)*(0*2) + 0.5 = 0 + 0.5 = 0.5
		{"half_won with explicit vf", "3.00", "half_won", "0.5", 2.0}, // (0.5*3) + 0.5 = 2
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := EffectiveFactor(tc.odds, tc.result, tc.voidFactor)
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if diff := got - tc.want; diff > 1e-9 || diff < -1e-9 {
				t.Fatalf("EffectiveFactor(%q, %q, %q) = %v, want %v", tc.odds, tc.result, tc.voidFactor, got, tc.want)
			}
		})
	}
}

func TestEffectiveFactor_Errors(t *testing.T) {
	if _, err := EffectiveFactor("", "won", ""); err == nil {
		t.Fatal("expected error on empty odds")
	}
	if _, err := EffectiveFactor("-1", "won", ""); err == nil {
		t.Fatal("expected error on negative odds")
	}
	if _, err := EffectiveFactor("2.0", "mystery", ""); err == nil {
		t.Fatal("expected error on unknown result")
	}
	if _, err := EffectiveFactor("2.0", "won", "not-a-number"); err == nil {
		t.Fatal("expected error on malformed void_factor")
	}
}

func TestSinglePayout(t *testing.T) {
	cases := []struct {
		name       string
		stake      int64
		odds       string
		result     string
		voidFactor string
		want       int64
	}{
		// 10 USDT = 10_000_000 micro
		{"won at 2.00 on 10 USDT", 10_000_000, "2.00", "won", "", 20_000_000},
		{"lost on 10 USDT", 10_000_000, "2.00", "lost", "", 0},
		{"void refund 10 USDT", 10_000_000, "2.00", "void", "", 10_000_000},
		{"half_won on 10 USDT at 2.00", 10_000_000, "2.00", "half_won", "", 15_000_000},
		{"half_lost on 10 USDT", 10_000_000, "2.00", "half_lost", "", 5_000_000},
		{"won at 1.85 on 12.34 USDT", 12_340_000, "1.85", "won", "", 22_829_000}, // 12.34 * 1.85 = 22.829
		// Floor rounding — odds of 1.8333... stake 3 → 5.4999... → 5.499999 micro = 5_499_999
		{"floor rounding", 3_000_000, "1.8333333", "won", "", 5_499_999},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := SinglePayout(tc.stake, tc.odds, tc.result, tc.voidFactor)
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if got != tc.want {
				t.Fatalf("SinglePayout(%d, %q, %q, %q) = %d, want %d",
					tc.stake, tc.odds, tc.result, tc.voidFactor, got, tc.want)
			}
		})
	}
}

func TestLedgerTypeFor(t *testing.T) {
	cases := map[string]string{
		"won":       "bet_payout",
		"lost":      "bet_payout",
		"void":      "bet_refund",
		"half_won":  "bet_payout",
		"half_lost": "bet_payout",
	}
	for result, want := range cases {
		if got := LedgerTypeFor(result); got != want {
			t.Fatalf("LedgerTypeFor(%q) = %q, want %q", result, got, want)
		}
	}
}
