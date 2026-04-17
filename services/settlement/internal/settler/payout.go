// Payout math. One function, many test cases.
//
// Oddin results map to our outcome_result enum via result + void_factor:
//   result=1, void_factor=0    → won       payout = stake * odds
//   result=0, void_factor=0    → lost      payout = 0
//   result=*, void_factor=1    → void      payout = stake
//   result=1, void_factor=0.5  → half_won  payout = stake/2 + stake/2 * odds
//   result=0, void_factor=0.5  → half_lost payout = stake/2
//
// General formula (per selection, as a fraction of stake):
//   effective = (1 - vf) * (result * odds) + vf
//   where result ∈ {0, 1}
//
// For single bets the ticket payout = stake * effective. For combos it
// would be stake * product(effective_i) — combos aren't in MVP scope.

package settler

import (
	"fmt"
	"math"
	"strconv"
)

// ResolvedResult is the subset of outcome_result we treat numerically.
type ResolvedResult string

const (
	ResultWon       ResolvedResult = "won"
	ResultLost      ResolvedResult = "lost"
	ResultVoid      ResolvedResult = "void"
	ResultHalfWon   ResolvedResult = "half_won"
	ResultHalfLost  ResolvedResult = "half_lost"
)

// EffectiveFactor returns the multiplier applied to `stake` for one
// selection. Returns an error only on parse failures.
func EffectiveFactor(oddsStr, result, voidFactor string) (float64, error) {
	odds, err := strconv.ParseFloat(oddsStr, 64)
	if err != nil || odds <= 0 {
		return 0, fmt.Errorf("odds: %q", oddsStr)
	}
	vf := 0.0
	if voidFactor != "" {
		parsed, err := strconv.ParseFloat(voidFactor, 64)
		if err != nil {
			return 0, fmt.Errorf("void_factor: %q", voidFactor)
		}
		vf = parsed
	}
	var res float64
	switch ResolvedResult(result) {
	case ResultWon:
		res = 1
	case ResultLost:
		res = 0
	case ResultVoid:
		// Full void — force vf=1 regardless of what Oddin sent.
		vf = 1
		res = 0
	case ResultHalfWon:
		res = 1
		if vf == 0 {
			vf = 0.5
		}
	case ResultHalfLost:
		res = 0
		if vf == 0 {
			vf = 0.5
		}
	default:
		return 0, fmt.Errorf("unknown result: %q", result)
	}
	// effective = (1 - vf) * (res * odds) + vf
	eff := (1.0-vf)*(res*odds) + vf
	return eff, nil
}

// SinglePayout returns the payout in micro-USDT for a single-selection
// ticket given its stake and resolved (result, void_factor) pair.
// Rounded to the floor to avoid ever over-paying by a sub-unit on
// irrational odds.
func SinglePayout(stakeMicro int64, oddsStr, result, voidFactor string) (int64, error) {
	eff, err := EffectiveFactor(oddsStr, result, voidFactor)
	if err != nil {
		return 0, err
	}
	if eff < 0 {
		eff = 0
	}
	f := float64(stakeMicro) * eff
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, fmt.Errorf("payout not finite")
	}
	return int64(math.Floor(f + 1e-9)), nil
}

// LedgerTypeFor picks the right wallet_tx_type value for the payout.
// We reserve 'bet_payout' for any positive credit that represents an
// actual win (even partial), and 'bet_refund' for pure voids — that way
// admin dashboards can tell them apart without inspecting the ticket.
func LedgerTypeFor(result string) string {
	switch ResolvedResult(result) {
	case ResultVoid:
		return "bet_refund"
	case ResultWon, ResultHalfWon, ResultHalfLost:
		// half_lost returns a fraction of stake — accounting-wise it's
		// a partial refund; we still classify under bet_payout because
		// it originated from a resulted market (not a manual void).
		return "bet_payout"
	default:
		return "bet_payout"
	}
}
