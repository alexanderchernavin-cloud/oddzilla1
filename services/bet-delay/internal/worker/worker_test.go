package worker

import (
	"testing"

	"github.com/oddzilla/bet-delay/internal/store"
)

func strPtr(s string) *string { return &s }

func TestEvaluate(t *testing.T) {
	// 5% drift tolerance matches DEFAULT_ODDS_DRIFT_TOLERANCE in @oddzilla/types.
	w := &Worker{driftTolerance: 0.05}

	cases := []struct {
		name       string
		selections []store.Selection
		rejectWant bool
		reasonWant string
	}{
		{
			name:       "no selections",
			selections: nil,
			rejectWant: true,
			reasonWant: "no_selections",
		},
		{
			name: "market suspended",
			selections: []store.Selection{
				{MarketStatus: -1, OutcomeActive: true, CurrentPublished: strPtr("1.85"), OddsAtPlacement: "1.85"},
			},
			rejectWant: true,
			reasonWant: "market_suspended",
		},
		{
			name: "outcome inactive",
			selections: []store.Selection{
				{MarketStatus: 1, OutcomeActive: false, CurrentPublished: strPtr("1.85"), OddsAtPlacement: "1.85"},
			},
			rejectWant: true,
			reasonWant: "outcome_inactive",
		},
		{
			name: "no current price",
			selections: []store.Selection{
				{MarketStatus: 1, OutcomeActive: true, CurrentPublished: nil, OddsAtPlacement: "1.85"},
			},
			rejectWant: true,
			reasonWant: "no_current_price",
		},
		{
			name: "odds within tolerance (exact)",
			selections: []store.Selection{
				{MarketStatus: 1, OutcomeActive: true, CurrentPublished: strPtr("1.85"), OddsAtPlacement: "1.85"},
			},
			rejectWant: false,
		},
		{
			name: "odds at boundary (4.9% drift)",
			selections: []store.Selection{
				{MarketStatus: 1, OutcomeActive: true, CurrentPublished: strPtr("1.94"), OddsAtPlacement: "1.85"},
			},
			rejectWant: false,
		},
		{
			name: "odds just beyond boundary (5.5% drift)",
			selections: []store.Selection{
				{MarketStatus: 1, OutcomeActive: true, CurrentPublished: strPtr("1.95"), OddsAtPlacement: "1.85"},
			},
			rejectWant: true,
			reasonWant: "odds_drift_exceeded",
		},
		{
			name: "odds parse error",
			selections: []store.Selection{
				{MarketStatus: 1, OutcomeActive: true, CurrentPublished: strPtr("nope"), OddsAtPlacement: "1.85"},
			},
			rejectWant: true,
			reasonWant: "odds_parse",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reject, reason := w.evaluate(tc.selections)
			if reject != tc.rejectWant {
				t.Fatalf("reject: got %v want %v", reject, tc.rejectWant)
			}
			if tc.rejectWant && reason != tc.reasonWant {
				t.Fatalf("reason: got %q want %q", reason, tc.reasonWant)
			}
		})
	}
}
