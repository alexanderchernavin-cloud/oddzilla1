// Tiny Go port of services/api/src/lib/bettor-odds-adjustment.ts —
// just the apply step. The cascade resolver lives on store.BettorAdjustment.
//
// Math must match the TS version byte-for-byte so the price the slip
// captured (server-rendered via the catalog endpoint) equals the price
// the worker recomputes during drift evaluation. Same multiplier, same
// high-side clamp, same 4dp floor truncation with trailing-zero trim.

package worker

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// adjustedOddsFloor is the lowest decimal price an adjusted outcome
// may show to a bettor. Must match the constant of the same name in
// services/api/src/lib/bettor-odds-adjustment.ts and the ws-gateway
// mirror — the slip captures the catalog response's adjusted price,
// so drift comparison + live tick re-rendering have to use the same
// clamp.
const adjustedOddsFloor = 1.001

// applyBettorAdjustment multiplies the raw decimal odds by (1 + bp/10000)
// and clamps to [adjustedOddsFloor, 1/probability]. The high-side clamp
// is the fair-odds ceiling (operator can't accidentally hand the bettor
// +EV); the low-side floor catches the geometric case where a small
// negative bp on near-1.0 raw odds dips below 1.0.
//
// The fair-odds clamp is skipped when probability is nil / unparseable
// (legacy outcomes without a probability column). bp=0 returns the raw
// odds unchanged.
func applyBettorAdjustment(rawOdds float64, probability *string, bp int) float64 {
	if bp == 0 {
		return rawOdds
	}
	if rawOdds <= 0 || math.IsNaN(rawOdds) || math.IsInf(rawOdds, 0) {
		return rawOdds
	}
	adjusted := rawOdds * (1.0 + float64(bp)/10000.0)
	if probability != nil && *probability != "" {
		p, err := strconv.ParseFloat(*probability, 64)
		if err == nil && p > 0 && p < 1 {
			fair := 1.0 / p
			if adjusted > fair {
				adjusted = fair
			}
		}
	}
	if adjusted < adjustedOddsFloor {
		adjusted = adjustedOddsFloor
	}
	return adjusted
}

// ladderUnits snaps a price DOWN onto the quote ladder, in units of 1e-4
// so the arithmetic is exact integer division.
//
// Port of ladderUnits in services/odds-publisher (and of quoteOnLadder in
// packages/types/src/odds.ts). It has to be here because this worker
// re-derives the adjusted price during drift evaluation: the slip
// captured a laddered number from the catalog endpoint, so a worker that
// skipped the ladder would compare against an off-rung value and reject
// the bet for drift that never happened.
//
// Prices under 1.01 pass through with full precision — the ladder has no
// rung between an unbettable 1.00 and a 1.01 longer than the feed said.
func ladderUnits(units int64) int64 {
	const floorUnits = 10100 // 1.01
	if units < floorUnits {
		return units
	}
	var step int64
	switch {
	case units < 100000: // < 10
		step = 100 // 0.01
	case units < 200000: // < 20
		step = 1000 // 0.1
	case units < 500000: // < 50
		step = 5000 // 0.5
	case units < 1000000: // < 100
		step = 10000 // 1
	default:
		step = 50000 // 5
	}
	return (units / step) * step
}

// formatOddsTrim renders a decimal-odds float at up to 4dp with trailing
// zeros trimmed to a 2dp minimum. Matches the publisher's
// formatPublishedOdds + the TS formatters byte-for-byte — every layer
// produces the same string for the same numeric value, so the price the
// slip captured equals the price this worker re-emits on accept.
//
// Small epsilon nudge in the scaled domain absorbs float64 round-down
// artefacts (1.0034 stored as 1.00339999...e). 1e-6 here is 1e-10 in
// raw odds, far below NUMERIC(10,4) resolution.
func formatOddsTrim(v float64) string {
	units := int64(math.Floor(v*10000 + 1e-6))
	if units < 0 {
		// Shouldn't happen for valid odds; defensive fallback.
		return fmt.Sprintf("%.2f", v)
	}
	units = ladderUnits(units)
	intP := units / 10000
	frac := units % 10000
	s := fmt.Sprintf("%d.%04d", intP, frac)
	for strings.HasSuffix(s, "0") {
		dot := strings.IndexByte(s, '.')
		if dot < 0 || len(s)-1-dot <= 2 {
			break
		}
		s = s[:len(s)-1]
	}
	return s
}
