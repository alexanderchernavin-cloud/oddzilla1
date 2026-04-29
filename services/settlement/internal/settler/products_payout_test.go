package settler

import (
	"testing"

	"github.com/oddzilla/settlement/internal/store"
)

func sel(odds, result, vf string) store.SelectionResult {
	return store.SelectionResult{OddsAtPlacement: odds, Result: result, VoidFactor: vf}
}

func TestTiplePayoutAnyWin(t *testing.T) {
	stake := int64(10_000_000)
	potential := int64(15_000_000) // stake × 1.5 from priceTiple at placement
	cases := []struct {
		name    string
		selects []store.SelectionResult
		want    int64
		ledger  string
	}{
		{"any_win",
			[]store.SelectionResult{sel("2.0", "won", ""), sel("3.0", "lost", "")},
			potential, "bet_payout"},
		{"all_lost",
			[]store.SelectionResult{sel("2.0", "lost", ""), sel("3.0", "lost", "")},
			0, "bet_payout"},
		{"all_void",
			[]store.SelectionResult{sel("2.0", "void", "1.0"), sel("3.0", "void", "1.0")},
			stake, "bet_refund"},
		{"void_plus_lost",
			[]store.SelectionResult{sel("2.0", "void", "1.0"), sel("3.0", "lost", "")},
			0, "bet_payout"},
		{"half_won_treated_as_winning",
			[]store.SelectionResult{sel("2.0", "half_won", "0.5"), sel("3.0", "lost", "")},
			potential, "bet_payout"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ledger, err := TiplePayout(stake, potential, tc.selects)
			if err != nil {
				t.Fatalf("err: %v", err)
			}
			if got != tc.want {
				t.Errorf("payout: got %d want %d", got, tc.want)
			}
			if ledger != tc.ledger {
				t.Errorf("ledger: got %s want %s", ledger, tc.ledger)
			}
		})
	}
}

func TestTippotPayoutTiers(t *testing.T) {
	// Tier table from the golden fixture: 3 even-money legs, 15% margin.
	meta := []byte(`{
	  "product": "tippot",
	  "n": 3,
	  "marginBp": 1500,
	  "tiers": [
	    {"k": 1, "pAtLeastK": "0.875000", "multiplier": "0.3312"},
	    {"k": 2, "pAtLeastK": "0.500000", "multiplier": "0.9109"},
	    {"k": 3, "pAtLeastK": "0.125000", "multiplier": "3.2298"}
	  ]
	}`)
	stake := int64(10_000_000)
	cases := []struct {
		name    string
		selects []store.SelectionResult
		want    int64
		ledger  string
	}{
		{"all_lost",
			[]store.SelectionResult{sel("2.0", "lost", ""), sel("2.0", "lost", ""), sel("2.0", "lost", "")},
			0, "bet_payout"},
		{"one_win_tier_1",
			[]store.SelectionResult{sel("2.0", "won", ""), sel("2.0", "lost", ""), sel("2.0", "lost", "")},
			3_312_000, "bet_payout"},
		{"two_wins_tier_2",
			[]store.SelectionResult{sel("2.0", "won", ""), sel("2.0", "won", ""), sel("2.0", "lost", "")},
			9_109_000, "bet_payout"},
		{"three_wins_tier_3",
			[]store.SelectionResult{sel("2.0", "won", ""), sel("2.0", "won", ""), sel("2.0", "won", "")},
			32_298_000, "bet_payout"},
		{"all_void",
			[]store.SelectionResult{sel("2.0", "void", "1.0"), sel("2.0", "void", "1.0"), sel("2.0", "void", "1.0")},
			stake, "bet_refund"},
		{"one_void_two_loss",
			[]store.SelectionResult{sel("2.0", "void", "1.0"), sel("2.0", "lost", ""), sel("2.0", "lost", "")},
			0, "bet_payout"},
		{"one_void_one_win_one_loss",
			[]store.SelectionResult{sel("2.0", "void", "1.0"), sel("2.0", "won", ""), sel("2.0", "lost", "")},
			// 1 winning leg → tier 1 still applies, voids don't reshape
			// the schedule (the contract was set at placement).
			3_312_000, "bet_payout"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ledger, err := TippotPayout(stake, meta, tc.selects)
			if err != nil {
				t.Fatalf("err: %v", err)
			}
			if got != tc.want {
				t.Errorf("payout: got %d want %d", got, tc.want)
			}
			if ledger != tc.ledger {
				t.Errorf("ledger: got %s want %s", ledger, tc.ledger)
			}
		})
	}
}

func TestTippotPayoutMissingMeta(t *testing.T) {
	_, _, err := TippotPayout(1000, nil, []store.SelectionResult{sel("2.0", "won", "")})
	if err == nil {
		t.Error("expected error for missing bet_meta")
	}
}
