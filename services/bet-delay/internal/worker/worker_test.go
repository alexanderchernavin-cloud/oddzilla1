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
			reject, reason := w.evaluate("combo", tc.selections)
			if reject != tc.rejectWant {
				t.Fatalf("reject: got %v want %v", reject, tc.rejectWant)
			}
			if tc.rejectWant && reason != tc.reasonWant {
				t.Fatalf("reason: got %q want %q", reason, tc.reasonWant)
			}
		})
	}
}

// BetBuilder placements anchor on Oddin's OBB SessionInfo at submit time;
// during the bet-delay window we only police market+outcome activity, not
// per-leg odds drift (the OBB session combined odds are not a product of
// per-leg odds, so per-leg drift is not a meaningful tripwire). A leg
// whose published price moved 50% must still pass during the bet-delay
// window for a betbuilder ticket — otherwise we'd reject a valid ticket
// the API already validated against Oddin's authoritative session.
func TestEvaluateBetBuilderSkipsPerLegDrift(t *testing.T) {
	w := &Worker{driftTolerance: 0.05}
	sels := []store.Selection{
		// 50% drift — would reject a normal combo, must pass for betbuilder.
		{MarketStatus: 1, OutcomeActive: true, CurrentPublished: strPtr("3.0"), OddsAtPlacement: "2.0"},
		{MarketStatus: 1, OutcomeActive: true, CurrentPublished: strPtr("4.5"), OddsAtPlacement: "3.0"},
	}
	reject, reason := w.evaluate("betbuilder", sels)
	if reject {
		t.Fatalf("betbuilder must skip drift; got reject=true reason=%q", reason)
	}
}

// Activity guards still apply to betbuilder — a market going inactive
// during the delay window must still reject the ticket. Otherwise the
// user would be debited stake on a leg that can't settle.
func TestEvaluateBetBuilderStillEnforcesActivity(t *testing.T) {
	w := &Worker{driftTolerance: 0.05}
	sels := []store.Selection{
		{MarketStatus: 1, OutcomeActive: true, CurrentPublished: strPtr("2.0"), OddsAtPlacement: "2.0"},
		// Outcome flipped inactive after submit.
		{MarketStatus: 1, OutcomeActive: false, CurrentPublished: strPtr("3.0"), OddsAtPlacement: "3.0"},
	}
	reject, reason := w.evaluate("betbuilder", sels)
	if !reject || reason != "outcome_inactive" {
		t.Fatalf("expected outcome_inactive reject, got reject=%v reason=%q", reject, reason)
	}
}
