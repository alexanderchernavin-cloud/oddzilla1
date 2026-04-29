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
// Single ticket payout = stake * effective.
// Combo  ticket payout = stake * product(effective_i). If every leg is a
// void the ticket refunds stake and the ledger type switches to
// bet_refund; any other outcome — including partial voids — still flows
// through bet_payout so admin dashboards can tell resolved markets from
// manual voids.

package settler

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"

	"github.com/oddzilla/settlement/internal/store"
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

// ComboPayout returns the payout in micro-USDT for a combo ticket given
// its stake and the resolved legs. All legs must already be resolved
// (the caller gates on UnresolvedCount==0). The payout floors so we
// never over-pay a fractional micro on irrational products of odds.
func ComboPayout(stakeMicro int64, selections []store.SelectionResult) (int64, string, error) {
	if len(selections) < 2 {
		return 0, "", fmt.Errorf("combo needs ≥2 selections, got %d", len(selections))
	}
	factor := 1.0
	allVoid := true
	for _, sel := range selections {
		eff, err := EffectiveFactor(sel.OddsAtPlacement, sel.Result, sel.VoidFactor)
		if err != nil {
			return 0, "", err
		}
		if sel.Result != string(ResultVoid) {
			allVoid = false
		}
		factor *= eff
	}
	if factor < 0 {
		factor = 0
	}
	f := float64(stakeMicro) * factor
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, "", fmt.Errorf("combo payout not finite")
	}
	payout := int64(math.Floor(f + 1e-9))
	ledger := "bet_payout"
	if allVoid {
		ledger = "bet_refund"
	}
	return payout, ledger, nil
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

// ─── Tiple ─────────────────────────────────────────────────────────────

// isWinningResult treats won + half_won as "winning" for the binary
// Tiple criterion. half_won marginally over-pays the bettor on the
// edge case of a half-win paired with full losses, but Tiple is meant
// to be permissive and the alternative (separately scaling for half)
// makes the product hard to explain.
func isWinningResult(r string) bool {
	switch ResolvedResult(r) {
	case ResultWon, ResultHalfWon:
		return true
	default:
		return false
	}
}

// TiplePayout settles a Tiple ticket. potentialPayoutMicro is the
// stake × offered_odds value frozen at placement.
//
//   any leg won/half_won  → pay potentialPayoutMicro, ledger=bet_payout
//   all legs void         → refund stake, ledger=bet_refund
//   else                  → 0, ledger=bet_payout (stake forfeit)
func TiplePayout(stakeMicro int64, potentialPayoutMicro int64, selections []store.SelectionResult) (int64, string, error) {
	if len(selections) < 2 {
		return 0, "", fmt.Errorf("tiple needs ≥2 selections, got %d", len(selections))
	}
	anyWin := false
	allVoid := true
	for _, sel := range selections {
		if isWinningResult(sel.Result) {
			anyWin = true
		}
		if sel.Result != string(ResultVoid) {
			allVoid = false
		}
	}
	if anyWin {
		return potentialPayoutMicro, "bet_payout", nil
	}
	if allVoid {
		return stakeMicro, "bet_refund", nil
	}
	return 0, "bet_payout", nil
}

// ─── Tippot ────────────────────────────────────────────────────────────

// TippotMeta is the JSON shape we wrote into tickets.bet_meta at
// placement. Mirrors packages/types/src/products.ts TippotMeta.
type TippotMeta struct {
	Product  string             `json:"product"`
	N        int                `json:"n"`
	MarginBp int                `json:"marginBp"`
	Tiers    []TippotMetaTier   `json:"tiers"`
}

type TippotMetaTier struct {
	K          int    `json:"k"`
	PAtLeastK  string `json:"pAtLeastK"`
	Multiplier string `json:"multiplier"`
}

// TippotPayout settles a Tippot ticket. The tier schedule frozen at
// placement is in the JSON blob; we count winning legs across the
// resolved selections (won + half_won), then look up the right tier.
//
//   all legs void         → refund stake, ledger=bet_refund
//   wins ≥ 1              → stake × tiers[wins-1].multiplier, ledger=bet_payout
//   wins == 0 (any losses)→ 0, ledger=bet_payout (stake forfeit)
//
// Half-won counts as a full "win" for tier selection (same Tiple logic).
// Voids do not count — they are simply removed from the tally; the
// schedule is used as-is. This is the contract the bettor saw at
// placement.
func TippotPayout(stakeMicro int64, betMetaJSON []byte, selections []store.SelectionResult) (int64, string, error) {
	if len(betMetaJSON) == 0 {
		return 0, "", fmt.Errorf("tippot ticket missing bet_meta")
	}
	var meta TippotMeta
	if err := json.Unmarshal(betMetaJSON, &meta); err != nil {
		return 0, "", fmt.Errorf("tippot bet_meta unmarshal: %w", err)
	}
	if meta.Product != "tippot" {
		return 0, "", fmt.Errorf("tippot bet_meta wrong product: %q", meta.Product)
	}
	if len(meta.Tiers) == 0 {
		return 0, "", fmt.Errorf("tippot bet_meta has no tiers")
	}
	// Count wins / voids. The N stored in meta is the original leg count;
	// we trust selections[].Result for the actual outcome.
	wins := 0
	voids := 0
	for _, sel := range selections {
		switch {
		case isWinningResult(sel.Result):
			wins++
		case sel.Result == string(ResultVoid):
			voids++
		}
	}
	if voids == len(selections) {
		return stakeMicro, "bet_refund", nil
	}
	if wins == 0 {
		return 0, "bet_payout", nil
	}
	// Look up tier — wins is in [1, N]. If wins exceeds the stored tier
	// table (shouldn't happen for a properly-placed ticket), cap at the
	// top tier rather than refuse to settle.
	idx := wins - 1
	if idx >= len(meta.Tiers) {
		idx = len(meta.Tiers) - 1
	}
	mult, err := strconv.ParseFloat(meta.Tiers[idx].Multiplier, 64)
	if err != nil {
		return 0, "", fmt.Errorf("tippot tier %d multiplier: %w", wins, err)
	}
	if mult < 0 {
		mult = 0
	}
	f := float64(stakeMicro) * mult
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, "", fmt.Errorf("tippot payout not finite")
	}
	return int64(math.Floor(f + 1e-9)), "bet_payout", nil
}
