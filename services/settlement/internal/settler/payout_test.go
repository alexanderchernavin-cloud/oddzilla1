package settler

import (
	"testing"

	"github.com/oddzilla/settlement/internal/store"
)

func legs(triples ...[3]string) []store.SelectionResult {
	out := make([]store.SelectionResult, 0, len(triples))
	for _, t := range triples {
		out = append(out, store.SelectionResult{
			OddsAtPlacement: t[0],
			Result:          t[1],
			VoidFactor:      t[2],
		})
	}
	return out
}

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

func TestComboPayout(t *testing.T) {
	cases := []struct {
		name       string
		stake      int64
		selections []store.SelectionResult
		wantMicro  int64
		wantLedger string
	}{
		{
			name:  "two-leg all won at 2.00 and 3.00 on 10 USDT",
			stake: 10_000_000,
			selections: legs(
				[3]string{"2.00", "won", ""},
				[3]string{"3.00", "won", ""},
			),
			wantMicro:  60_000_000, // 10 * 2 * 3
			wantLedger: "bet_payout",
		},
		{
			name:  "any leg lost → payout 0",
			stake: 10_000_000,
			selections: legs(
				[3]string{"2.00", "won", ""},
				[3]string{"3.00", "lost", ""},
			),
			wantMicro:  0,
			wantLedger: "bet_payout",
		},
		{
			name:  "all void → stake refund, bet_refund ledger",
			stake: 10_000_000,
			selections: legs(
				[3]string{"2.00", "void", ""},
				[3]string{"3.00", "void", ""},
			),
			wantMicro:  10_000_000,
			wantLedger: "bet_refund",
		},
		{
			name:  "won + void → factor ignores the void leg (×1), stays bet_payout",
			stake: 10_000_000,
			selections: legs(
				[3]string{"2.00", "won", ""},
				[3]string{"3.00", "void", ""},
			),
			wantMicro:  20_000_000, // 10 * 2 * 1
			wantLedger: "bet_payout",
		},
		{
			name:  "half_won + won on 10 USDT",
			stake: 10_000_000,
			selections: legs(
				[3]string{"2.00", "half_won", ""}, // eff = 1.5
				[3]string{"2.00", "won", ""},      // eff = 2.0
			),
			wantMicro:  30_000_000, // 10 * 1.5 * 2
			wantLedger: "bet_payout",
		},
		{
			name:  "three-leg with half_lost leg zeros to half of stake",
			stake: 10_000_000,
			selections: legs(
				[3]string{"2.00", "won", ""},       // eff = 2
				[3]string{"3.00", "won", ""},       // eff = 3
				[3]string{"2.00", "half_lost", ""}, // eff = 0.5
			),
			wantMicro:  30_000_000, // 10 * 2 * 3 * 0.5
			wantLedger: "bet_payout",
		},
		{
			name:  "floor rounding on irrational product",
			stake: 3_000_000,
			selections: legs(
				[3]string{"1.8333333", "won", ""},
				[3]string{"1.1", "won", ""},
			),
			// 3 * 1.8333333 * 1.1 = 6.04999989 → 6049999 micro (floor)
			wantMicro:  6_049_999,
			wantLedger: "bet_payout",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payout, ledger, err := ComboPayout(tc.stake, tc.selections)
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if payout != tc.wantMicro {
				t.Fatalf("payout = %d, want %d", payout, tc.wantMicro)
			}
			if ledger != tc.wantLedger {
				t.Fatalf("ledger = %q, want %q", ledger, tc.wantLedger)
			}
		})
	}
}

func TestComboPayout_Errors(t *testing.T) {
	if _, _, err := ComboPayout(10_000_000, legs([3]string{"2.00", "won", ""})); err == nil {
		t.Fatal("expected error on <2 selections")
	}
	if _, _, err := ComboPayout(10_000_000, legs(
		[3]string{"2.00", "won", ""},
		[3]string{"bad", "won", ""},
	)); err == nil {
		t.Fatal("expected error on malformed odds")
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
