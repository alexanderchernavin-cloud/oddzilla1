// Tiny Go port of services/api/src/lib/bettor-odds-adjustment.ts —
// just the apply step. The cascade resolver lives on store.BettorAdjustment.
//
// Math must match the TS version byte-for-byte so the price the slip
// captured (server-rendered via the catalog endpoint) equals the price
// the worker recomputes during drift evaluation. Same multiplier, same
// clamps, same 2-decimal floor truncation.

package worker

import (
	"fmt"
	"math"
	"strconv"
)

const minPublishedOdds = 1.01

// applyBettorAdjustment multiplies the raw decimal odds by (1 + bp/10000)
// then clamps to [1.01, 1/probability]. The fair-odds ceiling is skipped
// when probability is nil / unparseable (legacy outcomes without a
// probability column).
//
// bp=0 returns the raw odds unchanged (no float arithmetic at all). The
// fair-odds clamp is the operator-asked "can't go below zero margin"
// guarantee.
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
	if adjusted < minPublishedOdds {
		adjusted = minPublishedOdds
	}
	return adjusted
}

// formatOddsFloor2 renders a decimal-odds float as the 2-decimal
// floor-truncated string the published_odds column always carries on
// the wire. Matches the TS formatOdds() / odds-publisher representation.
//
// Small epsilon added before the floor — same trick the TS helper uses —
// so 1.95 doesn't collapse to "1.94" on 1.94999999… float artefacts.
func formatOddsFloor2(v float64) string {
	cents := int64(math.Floor(v*100 + 1e-9))
	return fmt.Sprintf("%d.%02d", cents/100, cents%100)
}
