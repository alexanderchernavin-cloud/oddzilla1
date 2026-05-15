package worker

import (
	"testing"

	"github.com/oddzilla/bet-delay/internal/store"
)

func strPtr(s string) *string { return &s }

func makePending(betType string, acceptOddsChanges bool, stakeMicro, potentialPayoutMicro int64) store.PendingTicket {
	return store.PendingTicket{
		ID:                   "tkt",
		BetType:              betType,
		StakeMicro:           stakeMicro,
		PotentialPayoutMicro: potentialPayoutMicro,
		AcceptOddsChanges:    acceptOddsChanges,
	}
}

func TestEvaluate(t *testing.T) {
	// 5% drift tolerance matches DEFAULT_ODDS_DRIFT_TOLERANCE in @oddzilla/types.
	w := &Worker{driftTolerance: 0.05}

	cases := []struct {
		name       string
		selections []store.Selection
		actionWant evalAction
		reasonWant string
	}{
		{
			name:       "no selections",
			selections: nil,
			actionWant: actionReject,
			reasonWant: "no_selections",
		},
		{
			name: "market suspended",
			selections: []store.Selection{
				{MarketStatus: -1, OutcomeActive: true, CurrentPublished: strPtr("1.85"), OddsAtPlacement: "1.85"},
			},
			actionWant: actionReject,
			reasonWant: "market_suspended",
		},
		{
			name: "outcome inactive",
			selections: []store.Selection{
				{MarketStatus: 1, OutcomeActive: false, CurrentPublished: strPtr("1.85"), OddsAtPlacement: "1.85"},
			},
			actionWant: actionReject,
			reasonWant: "outcome_inactive",
		},
		{
			name: "no current price",
			selections: []store.Selection{
				{MarketStatus: 1, OutcomeActive: true, CurrentPublished: nil, OddsAtPlacement: "1.85"},
			},
			actionWant: actionReject,
			reasonWant: "no_current_price",
		},
		{
			name: "odds within tolerance (exact)",
			selections: []store.Selection{
				{MarketStatus: 1, OutcomeActive: true, CurrentPublished: strPtr("1.85"), OddsAtPlacement: "1.85"},
			},
			actionWant: actionAccept,
		},
		{
			name: "odds at boundary (4.9% drift)",
			selections: []store.Selection{
				{MarketStatus: 1, OutcomeActive: true, CurrentPublished: strPtr("1.94"), OddsAtPlacement: "1.85"},
			},
			actionWant: actionAccept,
		},
		{
			name: "odds just beyond boundary (5.5% drift)",
			selections: []store.Selection{
				{MarketStatus: 1, OutcomeActive: true, CurrentPublished: strPtr("1.95"), OddsAtPlacement: "1.85"},
			},
			actionWant: actionReject,
			reasonWant: "odds_drift_exceeded",
		},
		{
			name: "odds parse error",
			selections: []store.Selection{
				{MarketStatus: 1, OutcomeActive: true, CurrentPublished: strPtr("nope"), OddsAtPlacement: "1.85"},
			},
			actionWant: actionReject,
			reasonWant: "odds_parse",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := w.evaluate(makePending("combo", false, 1, 1), tc.selections)
			if res.action != tc.actionWant {
				t.Fatalf("action: got %v want %v (reason %q)", res.action, tc.actionWant, res.reason)
			}
			if tc.actionWant == actionReject && res.reason != tc.reasonWant {
				t.Fatalf("reason: got %q want %q", res.reason, tc.reasonWant)
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
	res := w.evaluate(makePending("betbuilder", false, 1, 1), sels)
	if res.action != actionAccept {
		t.Fatalf("betbuilder must skip drift; got action=%v reason=%q", res.action, res.reason)
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
	res := w.evaluate(makePending("betbuilder", false, 1, 1), sels)
	if res.action != actionReject || res.reason != "outcome_inactive" {
		t.Fatalf("expected outcome_inactive reject, got action=%v reason=%q", res.action, res.reason)
	}
}

// Accept-odds-changes path: a single bet with drift beyond tolerance and
// the flag set should accept-with-updated-odds, recompute the potential
// payout from the current price, and emit one updated-leg entry.
func TestEvaluateAcceptOddsChangesSingleReprices(t *testing.T) {
	w := &Worker{driftTolerance: 0.05}
	sels := []store.Selection{
		{MarketID: 100, OutcomeID: "1", MarketStatus: 1, OutcomeActive: true, CurrentPublished: strPtr("2.10"), OddsAtPlacement: "1.85"},
	}
	// stake 10_000_000 (10 USDC), placement payout = 10_000_000 * 1.85 = 18_500_000.
	res := w.evaluate(makePending("single", true, 10_000_000, 18_500_000), sels)
	if res.action != actionAcceptWithUpdatedOdds {
		t.Fatalf("expected actionAcceptWithUpdatedOdds, got %v reason=%q", res.action, res.reason)
	}
	// 10_000_000 * 2.10 = 21_000_000
	if res.newPayoutMicro != 21_000_000 {
		t.Fatalf("newPayoutMicro: got %d want 21_000_000", res.newPayoutMicro)
	}
	if len(res.updatedLegs) != 1 || res.updatedLegs[0].MarketID != 100 || res.updatedLegs[0].NewOdds != "2.10" {
		t.Fatalf("unexpected updatedLegs: %+v", res.updatedLegs)
	}
}

// Accept-odds-changes for a combo with a mix of drifted and stable legs:
// only the drifted legs land in updatedLegs (so stable legs aren't
// touched), but the product odds use every leg's current price so the
// recomputed payout reflects the latest pricing across the whole ticket.
func TestEvaluateAcceptOddsChangesComboPartialDrift(t *testing.T) {
	w := &Worker{driftTolerance: 0.05}
	sels := []store.Selection{
		// Stable leg: placed at 2.00, current 2.00 — no drift.
		{MarketID: 100, OutcomeID: "1", MarketStatus: 1, OutcomeActive: true, CurrentPublished: strPtr("2.00"), OddsAtPlacement: "2.00"},
		// Drifted leg: placed at 1.85, current 2.10 — beyond tolerance.
		{MarketID: 200, OutcomeID: "2", MarketStatus: 1, OutcomeActive: true, CurrentPublished: strPtr("2.10"), OddsAtPlacement: "1.85"},
	}
	// stake 10_000_000, placement payout = 10_000_000 * 2.00 * 1.85 = 37_000_000.
	res := w.evaluate(makePending("combo", true, 10_000_000, 37_000_000), sels)
	if res.action != actionAcceptWithUpdatedOdds {
		t.Fatalf("expected actionAcceptWithUpdatedOdds, got %v reason=%q", res.action, res.reason)
	}
	// 10_000_000 * 2.00 * 2.10 = 42_000_000
	if res.newPayoutMicro != 42_000_000 {
		t.Fatalf("newPayoutMicro: got %d want 42_000_000", res.newPayoutMicro)
	}
	if len(res.updatedLegs) != 1 || res.updatedLegs[0].MarketID != 200 {
		t.Fatalf("expected only the drifted leg in updates, got: %+v", res.updatedLegs)
	}
}

// accept_odds_changes does NOT override a suspended market. The flag is
// "accept the new price", not "accept against a market that's no longer
// bettable".
func TestEvaluateAcceptOddsChangesStillRejectsSuspended(t *testing.T) {
	w := &Worker{driftTolerance: 0.05}
	sels := []store.Selection{
		{MarketID: 100, OutcomeID: "1", MarketStatus: -1, OutcomeActive: true, CurrentPublished: strPtr("2.10"), OddsAtPlacement: "1.85"},
	}
	res := w.evaluate(makePending("single", true, 10_000_000, 18_500_000), sels)
	if res.action != actionReject || res.reason != "market_suspended" {
		t.Fatalf("expected market_suspended reject, got action=%v reason=%q", res.action, res.reason)
	}
}

// accept_odds_changes is ignored for tiple/tippot — those products
// freeze pricing on probabilities at placement, not the per-leg
// published price. Drift continues to gate them.
func TestEvaluateAcceptOddsChangesIgnoredForTiple(t *testing.T) {
	w := &Worker{driftTolerance: 0.05}
	sels := []store.Selection{
		{MarketID: 100, OutcomeID: "1", MarketStatus: 1, OutcomeActive: true, CurrentPublished: strPtr("2.10"), OddsAtPlacement: "1.85"},
	}
	res := w.evaluate(makePending("tiple", true, 10_000_000, 18_500_000), sels)
	if res.action != actionReject || res.reason != "odds_drift_exceeded" {
		t.Fatalf("tiple must keep rejecting on drift, got action=%v reason=%q", res.action, res.reason)
	}
}

// Combi-boost multiplier on bet_meta should propagate into the
// recomputed payout when an accept-odds-changes combo re-prices.
func TestEvaluateAcceptOddsChangesPreservesCombiBoost(t *testing.T) {
	w := &Worker{driftTolerance: 0.05}
	sels := []store.Selection{
		{MarketID: 100, OutcomeID: "1", MarketStatus: 1, OutcomeActive: true, CurrentPublished: strPtr("2.10"), OddsAtPlacement: "1.85"},
		{MarketID: 200, OutcomeID: "1", MarketStatus: 1, OutcomeActive: true, CurrentPublished: strPtr("2.00"), OddsAtPlacement: "2.00"},
	}
	p := makePending("combo", true, 10_000_000, 0)
	p.BetMetaJSON = []byte(`{"product":"combo","boostMultiplier":"1.10"}`)
	res := w.evaluate(p, sels)
	if res.action != actionAcceptWithUpdatedOdds {
		t.Fatalf("expected actionAcceptWithUpdatedOdds, got %v reason=%q", res.action, res.reason)
	}
	// 10_000_000 * 2.10 * 2.00 * 1.10 = 46_200_000
	if res.newPayoutMicro != 46_200_000 {
		t.Fatalf("newPayoutMicro: got %d want 46_200_000 (boost should be applied)", res.newPayoutMicro)
	}
}
