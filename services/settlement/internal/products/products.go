// Package products implements the Tiple + Tippot pricing math used at
// settlement to validate / re-derive payout multipliers from the
// per-leg probabilities frozen on the ticket.
//
// CRITICAL: this MUST stay byte-identical to the TS reference at
// packages/types/src/products.ts. Both are tested against the shared
// golden fixture at docs/fixtures/products.json. Any divergence means
// the bookmaker (Go side) and the user-facing UI (TS side) will quote
// different numbers — a money-losing bug.
//
// Floor-truncation decimals are intentionally fixed:
//   Tiple offered odds  → 2 decimals
//   Tippot multipliers  → 4 decimals
//
// Floating-point order matches the TS implementation step-for-step;
// changing it will cause ULP-level divergence in the last decimal.

package products

import (
	"errors"
	"fmt"
	"math"
	"strconv"
)

const (
	tipleDecimals  = 2
	tippotDecimals = 4
)

// floorToDecimalsString matches packages/types/src/products.ts
// floorToDecimalsString. Negative / non-finite inputs collapse to "0.dd…".
func floorToDecimalsString(x float64, decimals int) string {
	if math.IsNaN(x) || math.IsInf(x, 0) || x < 0 {
		return fmt.Sprintf("%.*f", decimals, 0.0)
	}
	scale := math.Pow(10, float64(decimals))
	scaled := math.Floor(x * scale)
	return strconv.FormatFloat(scaled/scale, 'f', decimals, 64)
}

// ParseProbability parses a [0,1] decimal string. Returns an error on
// empty / unparseable / out-of-range inputs.
func ParseProbability(s string) (float64, error) {
	if s == "" {
		return 0, errors.New("probability is empty")
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, fmt.Errorf("probability parse: %w", err)
	}
	if math.IsNaN(f) || f < 0 || f > 1 {
		return 0, fmt.Errorf("probability out of range: %s", s)
	}
	return f, nil
}

// TipleQuote is the priced output for a Tiple ticket.
type TipleQuote struct {
	OfferedOdds     string
	FairProbability float64
	MarginBp        int
	N               int
}

// PriceTiple matches packages/types/src/products.ts priceTiple.
func PriceTiple(probabilities []float64, marginBp int) (TipleQuote, error) {
	n := len(probabilities)
	if n < 2 {
		return TipleQuote{}, fmt.Errorf("tiple needs ≥ 2 legs, got %d", n)
	}
	if marginBp < 0 || marginBp > 5000 {
		return TipleQuote{}, fmt.Errorf("margin_bp out of range: %d", marginBp)
	}
	for _, p := range probabilities {
		if !(p > 0 && p < 1) {
			return TipleQuote{}, fmt.Errorf("tiple needs each prob in (0,1), got %v", p)
		}
	}
	prodLose := 1.0
	for _, p := range probabilities {
		prodLose = prodLose * (1 - p)
	}
	fairProb := 1 - prodLose
	if fairProb <= 0 {
		return TipleQuote{}, errors.New("tiple fair probability is 0 — degenerate input")
	}
	divisor := 1 + float64(marginBp)/10000
	fairOdds := 1 / fairProb
	offered := fairOdds / divisor
	return TipleQuote{
		OfferedOdds:     floorToDecimalsString(offered, tipleDecimals),
		FairProbability: fairProb,
		MarginBp:        marginBp,
		N:               n,
	}, nil
}

// TippotTier mirrors packages/types/src/products.ts TippotTier.
type TippotTier struct {
	K          int
	PAtLeastK  string // 6 decimals, %.6f
	Multiplier string // 4 decimals, floor-truncated
}

// TippotQuote is the priced output for a Tippot ticket.
type TippotQuote struct {
	MarginBp int
	N        int
	Tiers    []TippotTier
}

// PriceTippot matches packages/types/src/products.ts priceTippot.
func PriceTippot(probabilities []float64, marginBp int) (TippotQuote, error) {
	n := len(probabilities)
	if n < 2 {
		return TippotQuote{}, fmt.Errorf("tippot needs ≥ 2 legs, got %d", n)
	}
	if marginBp < 0 || marginBp > 5000 {
		return TippotQuote{}, fmt.Errorf("margin_bp out of range: %d", marginBp)
	}
	for _, p := range probabilities {
		if !(p > 0 && p < 1) {
			return TippotQuote{}, fmt.Errorf("tippot needs each prob in (0,1), got %v", p)
		}
	}

	// Poisson-Binomial PMF via convolution. Same recurrence as TS.
	pmf := make([]float64, n+1)
	pmf[0] = 1
	for i := 0; i < n; i++ {
		p := probabilities[i]
		next := make([]float64, n+1)
		for k := 0; k <= i+1; k++ {
			var stayLose, gainWin float64
			if k <= i {
				stayLose = pmf[k] * (1 - p)
			}
			if k > 0 {
				gainWin = pmf[k-1] * p
			}
			next[k] = stayLose + gainWin
		}
		pmf = next
	}

	// P(>=k) suffix sums, k descending — same accumulation order as TS.
	pAtLeast := make([]float64, n+2)
	for k := n; k >= 1; k-- {
		pAtLeast[k] = pAtLeast[k+1] + pmf[k]
	}

	divisor := 1 + float64(marginBp)/10000
	tiers := make([]TippotTier, 0, n)
	cumulative := 0.0
	for k := 1; k <= n; k++ {
		pk := pAtLeast[k]
		if pk <= 0 {
			return TippotQuote{}, fmt.Errorf("tippot tier %d unreachable (P(>=%d) = %v)", k, k, pk)
		}
		tierOffered := ((1.0 / float64(n)) / pk) / divisor
		cumulative = cumulative + tierOffered
		tiers = append(tiers, TippotTier{
			K:          k,
			PAtLeastK:  strconv.FormatFloat(pk, 'f', 6, 64),
			Multiplier: floorToDecimalsString(cumulative, tippotDecimals),
		})
	}

	return TippotQuote{MarginBp: marginBp, N: n, Tiers: tiers}, nil
}
