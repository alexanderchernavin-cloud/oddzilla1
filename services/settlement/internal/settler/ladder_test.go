package settler

import (
	"sort"
	"strings"
	"testing"

	"github.com/oddzilla/settlement/internal/oddinxml"
	"github.com/oddzilla/settlement/internal/store"
)

func sib(line, results string) store.LadderSibling {
	return store.LadderSibling{Line: line, Results: results}
}

// render prints settled outcomes as "id=result,..." sorted by id.
func render(outs []oddinxml.Outcome) string {
	parts := make([]string, 0, len(outs))
	for _, o := range outs {
		parts = append(parts, o.ID+"="+o.Result)
	}
	sort.Strings(parts)
	return strings.Join(parts, ",")
}

// A settled sibling one rung up or down decides the line; the wrong side
// of the sibling decides nothing.
func TestInferTotalFromSibling(t *testing.T) {
	// Over 25.5 won: the total was 26+. Over 24.5 is therefore won.
	outs, why, ok := inferLine("threshold", "24.5", "4,5", []store.LadderSibling{sib("25.5", "4:lost:,5:won:")})
	if !ok || why != "threshold=25.5" {
		t.Fatalf("expected over 24.5 decided by 25.5, got ok=%v why=%q", ok, why)
	}
	if got := render(outs); got != "4=0,5=1" {
		t.Fatalf("over must win: %s", got)
	}
	// ...but says nothing about over 26.5.
	if _, why, ok := inferLine("threshold", "26.5", "4,5", []store.LadderSibling{sib("25.5", "4:lost:,5:won:")}); ok || why != "no sibling decides it" {
		t.Fatalf("26.5 must stay open, got ok=%v why=%q", ok, why)
	}
	// Under 25.5 won: the total was 25 or less. Under 26.5 is won.
	outs, _, ok = inferLine("threshold", "26.5", "4,5", []store.LadderSibling{sib("25.5", "4:won:,5:lost:")})
	if !ok || render(outs) != "4=1,5=0" {
		t.Fatalf("under must win at 26.5: ok=%v %s", ok, render(outs))
	}
	// A push at 26 pins the total exactly: over 25.5 won, under 26.5 won.
	if outs, _, ok := inferLine("threshold", "25.5", "4,5", []store.LadderSibling{sib("26", "4:void:1,5:void:1")}); !ok || render(outs) != "4=0,5=1" {
		t.Fatalf("push at 26 must settle over 25.5: ok=%v %s", ok, render(outs))
	}
	if outs, _, ok := inferLine("threshold", "26.5", "4,5", []store.LadderSibling{sib("26", "4:void:1,5:void:1")}); !ok || render(outs) != "4=1,5=0" {
		t.Fatalf("push at 26 must settle under 26.5: ok=%v %s", ok, render(outs))
	}
}

func TestInferHandicapFromSibling(t *testing.T) {
	// Home -1.5 won: home won by two or more. Home -0.5 (a higher line) is won.
	outs, why, ok := inferLine("handicap", "-0.5", "1,2", []store.LadderSibling{sib("-1.5", "1:won:,2:lost:")})
	if !ok || why != "handicap=-1.5" || render(outs) != "1=1,2=0" {
		t.Fatalf("home -0.5 must be won: ok=%v why=%q %s", ok, why, render(outs))
	}
	// Home -1.5 won says nothing about home -2.5.
	if _, _, ok := inferLine("handicap", "-2.5", "1,2", []store.LadderSibling{sib("-1.5", "1:won:,2:lost:")}); ok {
		t.Fatal("home -2.5 must stay open")
	}
	// Away won at home +1.5 (M + 1.5 < 0, home lost by two or more): away
	// also wins at home +0.5, a LOWER line.
	outs, _, ok = inferLine("handicap", "0.5", "1,2", []store.LadderSibling{sib("1.5", "1:lost:,2:won:")})
	if !ok || render(outs) != "1=0,2=1" {
		t.Fatalf("away must win at +0.5: ok=%v %s", ok, render(outs))
	}
	// Push at -1 (home won by exactly one): home wins at -0.5, away at -1.5.
	if outs, _, ok := inferLine("handicap", "-0.5", "1,2", []store.LadderSibling{sib("-1", "1:void:1,2:void:1")}); !ok || render(outs) != "1=1,2=0" {
		t.Fatalf("push at -1 must settle home -0.5: ok=%v %s", ok, render(outs))
	}
	if outs, _, ok := inferLine("handicap", "-1.5", "1,2", []store.LadderSibling{sib("-1", "1:void:1,2:void:1")}); !ok || render(outs) != "1=0,2=1" {
		t.Fatalf("push at -1 must settle home -1.5 for away: ok=%v %s", ok, render(outs))
	}
}

func TestInferRefusals(t *testing.T) {
	sibs := []store.LadderSibling{sib("25.5", "4:lost:,5:won:")}
	cases := []struct {
		name, key, line, ids string
		sibs                 []store.LadderSibling
		why                  string
	}{
		{"quarter line", "threshold", "24.25", "4,5", sibs, "quarter line"},
		{"race market carries a threshold but 1/2 outcomes", "threshold", "20", "1,2", sibs, "not an over/under total"},
		{"combo market", "threshold", "24.5", "154,155,156,157", sibs, "not an over/under total"},
		{"handicap with total outcomes", "handicap", "-1.5", "4,5", sibs, "not a home/away handicap"},
		{"half-won sibling is no bound", "threshold", "24.5", "4,5", []store.LadderSibling{sib("25.25", "4:half_lost:0.5,5:half_won:0.5")}, "no sibling decides it"},
		{"unreadable line", "threshold", "abc", "4,5", sibs, "unreadable line"},
		{"siblings disagree", "threshold", "24.5", "4,5", []store.LadderSibling{sib("25.5", "4:lost:,5:won:"), sib("23.5", "4:won:,5:lost:")}, "siblings disagree"},
		{"unknown key", "map", "2", "4,5", sibs, "unknown line key"},
	}
	for _, c := range cases {
		if outs, why, ok := inferLine(c.key, c.line, c.ids, c.sibs); ok || why != c.why {
			t.Errorf("%s: expected refusal %q, got ok=%v why=%q outs=%v", c.name, c.why, ok, why, outs)
		}
	}
}

func TestSiblingBound(t *testing.T) {
	if b, ok := siblingBound("4:lost:,5:won:", "5", "4"); !ok || b != 1 {
		t.Fatalf("over won → +1, got %d %v", b, ok)
	}
	if b, ok := siblingBound("4:won:,5:lost:", "5", "4"); !ok || b != -1 {
		t.Fatalf("under won → -1, got %d %v", b, ok)
	}
	if b, ok := siblingBound("4:void:1,5:void:1", "5", "4"); !ok || b != 0 {
		t.Fatalf("push → 0, got %d %v", b, ok)
	}
	if _, ok := siblingBound("4:void:1,5:won:", "5", "4"); ok {
		t.Fatal("one-sided void is not a bound")
	}
	if _, ok := siblingBound("5:won:", "5", "4"); ok {
		t.Fatal("a missing outcome is not a bound")
	}
}
