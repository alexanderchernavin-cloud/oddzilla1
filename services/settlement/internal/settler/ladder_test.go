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

// render prints settled outcomes as "id=result[/vf],..." sorted by id.
func render(outs []oddinxml.Outcome) string {
	parts := make([]string, 0, len(outs))
	for _, o := range outs {
		s := o.ID + "=" + o.Result
		if o.VoidFactor != "" {
			s += "/" + o.VoidFactor
		}
		parts = append(parts, s)
	}
	sort.Strings(parts)
	return strings.Join(parts, ",")
}

func TestGradeHighMatchesFonbetGrader(t *testing.T) {
	// totals: over wins above the line, pushes on it, quarter lines split
	cases := []struct {
		kind  string
		value int
		line  float64
		want  graded
	}{
		{"threshold", 3, 2.5, gWon},
		{"threshold", 2, 2.5, gLost},
		{"threshold", 2, 2, gVoid},
		{"threshold", 2, 2.25, gHalfLost}, // 2.0 push + 2.5 loss
		{"threshold", 3, 2.75, gHalfWon},  // 2.5 win + 3 push
		{"threshold", 4, 2.75, gWon},
		// handicaps: home line, diff = margin + line
		{"handicap", 1, -0.5, gWon},
		{"handicap", 0, -0.5, gLost},
		{"handicap", 0, 0, gVoid},
		{"handicap", 2, -2, gVoid},
		{"handicap", 1, -1.25, gHalfLost}, // -1 push, -1.5 loss
		{"handicap", 2, -1.75, gHalfWon},  // -1.5 win, -2 push
		{"handicap", -2, 1.75, gHalfLost}, // +1.5 loss, +2 push
		{"handicap", 0, 0.25, gHalfWon},   // 0 push, +0.5 win
	}
	for _, c := range cases {
		if got := gradeHigh(c.kind, c.value, c.line); got != c.want {
			t.Errorf("gradeHigh(%s, %d, %v) = %v, want %v", c.kind, c.value, c.line, got, c.want)
		}
	}
}

// One-sided bounds: a full won / lost sibling decides the lines on the far
// side of it and nothing else.
func TestInferTotalFromOneSidedSibling(t *testing.T) {
	// Over 25.5 won: the total was 26+. Over 24.5 is therefore won.
	outs, why, ok := inferLine("threshold", "24.5", "4,5", []store.LadderSibling{sib("25.5", "4:lost:,5:won:")})
	if !ok || !strings.HasPrefix(why, "threshold=25.5") {
		t.Fatalf("expected over 24.5 decided by 25.5, got ok=%v why=%q", ok, why)
	}
	if got := render(outs); got != "4=0,5=1" {
		t.Fatalf("over must win: %s", got)
	}
	// ...but says nothing about over 26.5, nor about the integer 26.
	for _, y := range []string{"26.5", "26"} {
		if _, why, ok := inferLine("threshold", y, "4,5", []store.LadderSibling{sib("25.5", "4:lost:,5:won:")}); ok || why != "no sibling decides it" {
			t.Fatalf("%s must stay open, got ok=%v why=%q", y, ok, why)
		}
	}
	// Under 25.5 won: 25 or less. Under 26.5 is won.
	outs, _, ok = inferLine("threshold", "26.5", "4,5", []store.LadderSibling{sib("25.5", "4:won:,5:lost:")})
	if !ok || render(outs) != "4=1,5=0" {
		t.Fatalf("under must win at 26.5: ok=%v %s", ok, render(outs))
	}
}

// Pins: a push or a half result fixes the number exactly, and then every
// line settles with its real result — pushes and half results included.
func TestInferTotalFromPinnedValue(t *testing.T) {
	// A push at 26 pins T = 26.
	push := []store.LadderSibling{sib("26", "4:void:1,5:void:1")}
	if outs, why, ok := inferLine("threshold", "25.5", "4,5", push); !ok || render(outs) != "4=0,5=1" || !strings.Contains(why, "(value 26)") {
		t.Fatalf("push at 26 must settle over 25.5: ok=%v %s why=%q", ok, render(outs), why)
	}
	if outs, _, ok := inferLine("threshold", "26.5", "4,5", push); !ok || render(outs) != "4=1,5=0" {
		t.Fatalf("push at 26 must settle under 26.5: ok=%v %s", ok, render(outs))
	}
	// The open line 26.25 splits into 26 (push) and 26.5 (under): under half-won.
	if outs, _, ok := inferLine("threshold", "26.25", "4,5", push); !ok || render(outs) != "4=1/0.5,5=0/0.5" {
		t.Fatalf("push at 26 must half-settle 26.25: ok=%v %s", ok, render(outs))
	}
	// Half results pin too: over half-won at 3.75 means T = 4 (3.5 won, 4
	// pushed) — the production shape that stayed "undecided" before.
	half := []store.LadderSibling{
		sib("2", "4:lost:,5:won:"), sib("3.5", "4:lost:,5:won:"),
		sib("3.75", "4:half_lost:0.5,5:half_won:0.5"),
	}
	outs, why, ok := inferLine("threshold", "4", "4,5", half)
	if !ok || render(outs) != "4=1/1,5=1/1" || !strings.Contains(why, "(value 4)") {
		t.Fatalf("T pinned to 4 must push the integer line 4: ok=%v %s why=%q", ok, render(outs), why)
	}
	if outs, _, ok := inferLine("threshold", "4.5", "4,5", half); !ok || render(outs) != "4=1,5=0" {
		t.Fatalf("T = 4 must settle under 4.5: ok=%v %s", ok, render(outs))
	}
	// Under half-won at 2.25 means T = 2 (2.0 pushed, 2.5 under won).
	if outs, _, ok := inferLine("threshold", "2", "4,5", []store.LadderSibling{sib("2.25", "4:half_won:0.5,5:half_lost:0.5")}); !ok || render(outs) != "4=1/1,5=1/1" {
		t.Fatalf("T = 2 must push the line 2: ok=%v %s", ok, render(outs))
	}
}

func TestInferHandicap(t *testing.T) {
	// Home -1.5 won: margin 2+. Home -0.5 is won; home -2.5 is undecided.
	outs, _, ok := inferLine("handicap", "-0.5", "1,2", []store.LadderSibling{sib("-1.5", "1:won:,2:lost:")})
	if !ok || render(outs) != "1=1,2=0" {
		t.Fatalf("home -0.5 must be won: ok=%v %s", ok, render(outs))
	}
	if _, _, ok := inferLine("handicap", "-2.5", "1,2", []store.LadderSibling{sib("-1.5", "1:won:,2:lost:")}); ok {
		t.Fatal("home -2.5 must stay open")
	}
	// Away won at home +1.5 (home lost by two or more): away wins at +0.5 too.
	outs, _, ok = inferLine("handicap", "0.5", "1,2", []store.LadderSibling{sib("1.5", "1:lost:,2:won:")})
	if !ok || render(outs) != "1=0,2=1" {
		t.Fatalf("away must win at +0.5: ok=%v %s", ok, render(outs))
	}
	// Push at -1 pins the margin at 1: home wins -0.5, away wins -1.5, the
	// quarter line -1.25 is a half loss for home (-1 push, -1.5 lost).
	push := []store.LadderSibling{sib("-1", "1:void:1,2:void:1")}
	if outs, _, ok := inferLine("handicap", "-0.5", "1,2", push); !ok || render(outs) != "1=1,2=0" {
		t.Fatalf("margin 1 must settle home -0.5: ok=%v %s", ok, render(outs))
	}
	if outs, _, ok := inferLine("handicap", "-1.5", "1,2", push); !ok || render(outs) != "1=0,2=1" {
		t.Fatalf("margin 1 must settle home -1.5 for away: ok=%v %s", ok, render(outs))
	}
	if outs, _, ok := inferLine("handicap", "-1.25", "1,2", push); !ok || render(outs) != "1=0/0.5,2=1/0.5" {
		t.Fatalf("margin 1 must half-settle home -1.25: ok=%v %s", ok, render(outs))
	}
	// Production shape: home half-won at -1.75 (-1.5 won, -2 pushed) pins
	// the margin at 2, so the open integer line -2 is a push.
	if outs, _, ok := inferLine("handicap", "-2", "1,2", []store.LadderSibling{sib("-1.75", "1:half_won:0.5,2:half_lost:0.5"), sib("-1.5", "1:won:,2:lost:")}); !ok || render(outs) != "1=1/1,2=1/1" {
		t.Fatalf("margin 2 must push home -2: ok=%v %s", ok, render(outs))
	}
	// A one-sided bound can decide a quarter line fully: away won at 0 means
	// margin <= -1, so home -0.25 (legs 0 and -0.5) is lost on both legs.
	if outs, _, ok := inferLine("handicap", "-0.25", "1,2", []store.LadderSibling{sib("0", "1:lost:,2:won:")}); !ok || render(outs) != "1=0,2=1" {
		t.Fatalf("margin <= -1 must settle home -0.25 as lost: ok=%v %s", ok, render(outs))
	}
}

func TestInferRefusals(t *testing.T) {
	sibs := []store.LadderSibling{sib("25.5", "4:lost:,5:won:")}
	cases := []struct {
		name, key, line, ids string
		sibs                 []store.LadderSibling
		why                  string
	}{
		{"race market carries a threshold but 1/2 outcomes", "threshold", "20", "1,2", sibs, "not an over/under total"},
		{"combo market", "threshold", "24.5", "154,155,156,157", sibs, "not an over/under total"},
		{"handicap with total outcomes", "handicap", "-1.5", "4,5", sibs, "not a home/away handicap"},
		{"unreadable line", "threshold", "abc", "4,5", sibs, "unreadable line"},
		{"one-sided sibling on the wrong side", "threshold", "26.5", "4,5", sibs, "no sibling decides it"},
		{"siblings disagree", "threshold", "24.5", "4,5", []store.LadderSibling{sib("25.5", "4:lost:,5:won:"), sib("23.5", "4:won:,5:lost:")}, "siblings disagree"},
		{"sibling with one side missing is unusable", "threshold", "24.5", "4,5", []store.LadderSibling{sib("25.5", "5:won:")}, "no usable sibling"},
		{"sibling whose sides do not mirror is unusable", "threshold", "24.5", "4,5", []store.LadderSibling{sib("25.5", "4:won:,5:won:")}, "no usable sibling"},
		{"unknown key", "map", "2", "4,5", sibs, "unknown line key"},
	}
	for _, c := range cases {
		if outs, why, ok := inferLine(c.key, c.line, c.ids, c.sibs); ok || why != c.why {
			t.Errorf("%s: expected refusal %q, got ok=%v why=%q outs=%v", c.name, c.why, ok, why, outs)
		}
	}
}

func TestSiblingResult(t *testing.T) {
	if g, ok := siblingResult("4:lost:,5:won:", "5", "4"); !ok || g != gWon {
		t.Fatalf("over won: %v %v", g, ok)
	}
	if g, ok := siblingResult("4:won:,5:lost:", "5", "4"); !ok || g != gLost {
		t.Fatalf("under won: %v %v", g, ok)
	}
	if g, ok := siblingResult("4:void:1,5:void:1", "5", "4"); !ok || g != gVoid {
		t.Fatalf("push: %v %v", g, ok)
	}
	if g, ok := siblingResult("4:half_lost:0.5,5:half_won:0.5", "5", "4"); !ok || g != gHalfWon {
		t.Fatalf("half: %v %v", g, ok)
	}
	if _, ok := siblingResult("4:void:1,5:won:", "5", "4"); ok {
		t.Fatal("one-sided void does not mirror")
	}
}
