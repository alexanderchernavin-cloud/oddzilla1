package settle

import (
	"testing"

	"github.com/oddzilla/fonbet-ingester/internal/fonbet"
)

func TestParseScore(t *testing.T) {
	s, ok := fonbet.ParseScore("2:2 (1-0 1-1 0-1 1-0)")
	if !ok || s.Home != 2 || s.Away != 2 || len(s.Periods) != 4 || s.Periods[3] != [2]int{1, 0} {
		t.Fatalf("parse: %+v %v", s, ok)
	}
	if _, ok := fonbet.ParseScore("cancelled"); ok {
		t.Fatalf("text score must not parse")
	}
	s, _ = fonbet.ParseScore("2:4")
	if s.Home != 2 || s.Away != 4 || len(s.Periods) != 0 {
		t.Fatalf("plain score: %+v", s)
	}
}

func TestHandicap(t *testing.T) {
	type c struct {
		h, a   int
		line   float64
		r1, r2 graded
	}
	for _, tc := range []c{
		{2, 1, -0.5, gWon, gLost},
		{1, 1, -0.5, gLost, gWon},
		{1, 1, 0, gVoid, gVoid},
		{3, 1, -2, gVoid, gVoid},
		{3, 1, -1.5, gWon, gLost},
		{2, 1, -1.25, gHalfLost, gHalfWon}, // 2-1 with -1 = push, with -1.5 = loss → half lost for h1
		{2, 0, -1.75, gHalfWon, gHalfLost}, // -1.5 win, -2 push
		{0, 2, 1.75, gHalfLost, gHalfWon},  // +1.5 loss, +2 push
		{0, 0, 0.25, gHalfWon, gHalfLost},  // 0 push + 0.5 win
	} {
		r1, r2 := gradeHandicap(tc.h, tc.a, tc.line)
		if r1 != tc.r1 || r2 != tc.r2 {
			t.Errorf("handicap(%d,%d,%v) = %v %v, want %v %v", tc.h, tc.a, tc.line, r1, r2, tc.r1, tc.r2)
		}
	}
}

func TestTotal(t *testing.T) {
	over, under := gradeTotal(3, 2.5)
	if over != gWon || under != gLost {
		t.Fatalf("3 over 2.5: %v %v", over, under)
	}
	over, under = gradeTotal(2, 2)
	if over != gVoid || under != gVoid {
		t.Fatalf("push: %v %v", over, under)
	}
	over, under = gradeTotal(2, 2.25) // 2.0 push + 2.5 loss → half lost
	if over != gHalfLost || under != gHalfWon {
		t.Fatalf("quarter: %v %v", over, under)
	}
	over, under = gradeTotal(3, 2.75) // 2.5 win + 3 push → half won
	if over != gHalfWon || under != gHalfLost {
		t.Fatalf("quarter2: %v %v", over, under)
	}
}

// fixtureIndex is a slice of the English catalogue: the main 1X2 table
// with its double-chance cells, handicap, total, an "including overtime"
// table the name guard must refuse, Fonbet's nameless "Both teams to
// score" table (2800) and the two-way "To win the match" table (491), which
// Fonbet does not flag as main.
func fixtureIndex() *fonbet.Index {
	cat := &fonbet.Catalog{Lang: "en", Groups: []fonbet.Group{{Name: "Main bets", Tables: []fonbet.Table{
		{Num: 120, Name: "Match result", IsMain: true, Rows: [][]fonbet.Cell{
			{{Name: "1"}, {Name: "X"}, {Name: "2"}, {Name: "1X"}, {Name: "12"}, {Name: "X2"}},
			{{Kind: "value", FactorID: 921}, {Kind: "value", FactorID: 922}, {Kind: "value", FactorID: 923}, {Kind: "value", FactorID: 924}, {Kind: "value", FactorID: 1571}, {Kind: "value", FactorID: 925}},
		}},
		{Num: 304, Name: "Handicap", IsMain: true, Rows: [][]fonbet.Cell{
			{{Name: ""}, {Name: "1"}, {Name: ""}, {Name: "2"}},
			{{Kind: "param", FactorID: 910}, {Kind: "value", FactorID: 910}, {Kind: "param", FactorID: 912}, {Kind: "value", FactorID: 912}},
		}},
		{Num: 305, Name: "Total", IsMain: true, Rows: [][]fonbet.Cell{
			{{Name: ""}, {Name: "O"}, {Name: "U"}},
			{{Kind: "param", FactorID: 930}, {Kind: "value", FactorID: 930}, {Kind: "value", FactorID: 931}},
		}},
		{Num: 400, Name: "Result including overtime", IsMain: true, Rows: [][]fonbet.Cell{
			{{Name: "1"}, {Name: "2"}},
			{{Kind: "value", FactorID: 5001}, {Kind: "value", FactorID: 5002}},
		}},
		{Num: 2800, Name: "", Rows: [][]fonbet.Cell{
			{{Name: ""}, {Name: "Yes"}, {Name: "No"}},
			{{Name: "Both teams to score"}, {Kind: "value", FactorID: 4241}, {Kind: "value", FactorID: 4242}},
		}},
		{Num: 491, Name: "To win the match", Rows: [][]fonbet.Cell{
			{{Name: "1"}, {Name: "2"}},
			{{Kind: "value", FactorID: 7035}, {Kind: "value", FactorID: 7036}},
		}},
	}}}}
	return fonbet.BuildIndex(cat)
}

func TestGradeFootball(t *testing.T) {
	idx := fixtureIndex()
	ss := ScoreSet{Main: fonbet.Score{Home: 2, Away: 1, Periods: [][2]int{{1, 1}, {1, 0}}},
		Stats: map[string]fonbet.Score{"corners": {Home: 8, Away: 2, Periods: [][2]int{{3, 2}, {5, 0}}}}}

	outs, ok, why := Grade(Market{PMID: 1000120, TableNum: 120, Specs: map[string]string{}, OutcomeIDs: []string{"1", "3", "2"}}, idx, "", 1, ss)
	if !ok || len(outs) != 3 || outs[0] != (Outcome{"1", "1", ""}) || outs[1] != (Outcome{"2", "0", ""}) || outs[2] != (Outcome{"3", "0", ""}) {
		t.Fatalf("winner: %+v %v %s", outs, ok, why)
	}
	outs, ok, _ = Grade(Market{PMID: 1900120, TableNum: 120, DoubleChance: true, Specs: map[string]string{}, OutcomeIDs: []string{"924", "1571", "925"}}, idx, "", 1, ss)
	if !ok || outs[0] != (Outcome{"1571", "1", ""}) || outs[1] != (Outcome{"924", "1", ""}) || outs[2] != (Outcome{"925", "0", ""}) {
		t.Fatalf("double chance: %+v", outs)
	}
	outs, ok, _ = Grade(Market{PMID: 1000304, TableNum: 304, Specs: map[string]string{"handicap": "-0.5"}, OutcomeIDs: []string{"h1", "h2"}}, idx, "", 1, ss)
	if !ok || outs[0] != (Outcome{"h1", "1", ""}) || outs[1] != (Outcome{"h2", "0", ""}) {
		t.Fatalf("handicap: %+v", outs)
	}
	// 1st half total 2.5 → 2 goals → under
	outs, ok, _ = Grade(Market{PMID: 1000305, TableNum: 305, Specs: map[string]string{"threshold": "2.5", "variant": "fb:100201"}, OutcomeIDs: []string{"over", "under"}}, idx, "1st half", 1, ss)
	if !ok || outs[0] != (Outcome{"over", "0", ""}) || outs[1] != (Outcome{"under", "1", ""}) {
		t.Fatalf("half total: %+v", outs)
	}
	// 1st-half winner keeps factor ids and double-chance cells: 1-1 → X, 1X, X2 win
	outs, ok, why = Grade(Market{PMID: 1000120, TableNum: 120, Specs: map[string]string{"variant": "fb:100201"}, OutcomeIDs: []string{"921", "922", "923", "924", "1571", "925"}}, idx, "1st half", 1, ss)
	if !ok || len(outs) != 6 {
		t.Fatalf("half winner: %+v %s", outs, why)
	}
	for _, o := range outs {
		want := map[string]string{"921": "0", "922": "1", "923": "0", "924": "1", "1571": "0", "925": "1"}[o.ID]
		if o.Result != want {
			t.Fatalf("half winner outcome %s = %s, want %s", o.ID, o.Result, want)
		}
	}
	// corners total 9.5 → 10 corners → over
	outs, ok, _ = Grade(Market{PMID: 1000305, TableNum: 305, Specs: map[string]string{"threshold": "9.5", "variant": "fb:400100"}, OutcomeIDs: []string{"over", "under"}}, idx, "corners", 1, ss)
	if !ok || outs[0] != (Outcome{"over", "1", ""}) {
		t.Fatalf("corners: %+v", outs)
	}
	// home team total (side)
	outs, ok, _ = Grade(Market{PMID: 1000305, TableNum: 305, Specs: map[string]string{"threshold": "1.5", "side": "home"}, OutcomeIDs: []string{"over", "under"}}, idx, "", 1, ss)
	if !ok || outs[0] != (Outcome{"over", "1", ""}) {
		t.Fatalf("team total: %+v", outs)
	}
	// OT table is skipped by name, unknown sport is skipped, missing stat is skipped
	if _, ok, why = Grade(Market{PMID: 1000400, TableNum: 400, Specs: map[string]string{}, OutcomeIDs: []string{"5001", "5002"}}, idx, "", 2, ss); ok || why != "table needs manual settlement" {
		t.Fatalf("OT table must be skipped: ok=%v why=%q", ok, why)
	}
	if _, ok, why = Grade(Market{PMID: 1000120, TableNum: 120, Specs: map[string]string{}, OutcomeIDs: []string{"1", "3", "2"}}, idx, "", 999999, ss); ok || why != "no score" {
		t.Fatalf("unknown sport must be skipped: ok=%v why=%q", ok, why)
	}
	if _, ok, _ = Grade(Market{PMID: 1000305, TableNum: 305, Specs: map[string]string{"threshold": "4.5", "variant": "fb:1"}, OutcomeIDs: []string{"over", "under"}}, idx, "yellow cards", 1, ss); ok {
		t.Fatalf("missing stat row must be skipped")
	}
}

// Both teams to score: table 2800 has no name, only two factors labelled
// "Both teams to score Yes" / "... No". 2:1 → yes; the 1st half (1-1) →
// yes; the 2nd half (1-0) → no.
func TestGradeBothTeamsToScore(t *testing.T) {
	idx := fixtureIndex()
	ss := ScoreSet{Main: fonbet.Score{Home: 2, Away: 1, Periods: [][2]int{{1, 1}, {1, 0}}}}
	mk := Market{PMID: 1002800, TableNum: 2800, Specs: map[string]string{}, OutcomeIDs: []string{"4241", "4242"}}
	outs, ok, why := Grade(mk, idx, "", 1, ss)
	if !ok || outs[0] != (Outcome{"4241", "1", ""}) || outs[1] != (Outcome{"4242", "0", ""}) {
		t.Fatalf("btts match: %+v %v %s", outs, ok, why)
	}
	mk.Specs = map[string]string{"variant": "fb:100202"}
	outs, ok, why = Grade(mk, idx, "2nd half", 1, ss)
	if !ok || outs[0] != (Outcome{"4241", "0", ""}) || outs[1] != (Outcome{"4242", "1", ""}) {
		t.Fatalf("btts 2nd half: %+v %v %s", outs, ok, why)
	}
	// A nil score (0-0 draw) is "no": both must be positive.
	outs, ok, _ = Grade(Market{PMID: 1002800, TableNum: 2800, Specs: map[string]string{}, OutcomeIDs: []string{"4241", "4242"}}, idx, "", 1, ScoreSet{Main: fonbet.Score{}})
	if !ok || outs[0].Result != "0" || outs[1].Result != "1" {
		t.Fatalf("btts 0-0: %+v", outs)
	}
}

// "To win the match" (491) is a two-way winner Fonbet does not flag as
// main. In hockey it includes overtime and the shootout, which is exactly
// the existing two-way tie-break path.
func TestGradeTwoWayWinnerTable(t *testing.T) {
	idx := fixtureIndex()
	mk := Market{PMID: 1000491, TableNum: 491, Specs: map[string]string{}, OutcomeIDs: []string{"7035", "7036"}}
	// Regulation 3:1 — home.
	outs, ok, why := Grade(mk, idx, "", 2, ScoreSet{Main: fonbet.Score{Home: 3, Away: 1}})
	if !ok || outs[0] != (Outcome{"7035", "1", ""}) || outs[1] != (Outcome{"7036", "0", ""}) {
		t.Fatalf("two-way regulation: %+v %v %s", outs, ok, why)
	}
	// 2:2 after regulation, shootout 1:2 — away.
	ss := ScoreSet{Main: fonbet.Score{Home: 2, Away: 2}, Shoot: &fonbet.Score{Home: 1, Away: 2}}
	outs, ok, why = Grade(mk, idx, "", 2, ss)
	if !ok || outs[0].Result != "0" || outs[1].Result != "1" {
		t.Fatalf("two-way shootout: %+v %v %s", outs, ok, why)
	}
	// 2:2 with no tie-break rows: stays open.
	if _, ok, why = Grade(mk, idx, "", 2, ScoreSet{Main: fonbet.Score{Home: 2, Away: 2}}); ok || why != "two-way market tied in main time" {
		t.Fatalf("two-way tie must stay open: ok=%v why=%q", ok, why)
	}
	// Beach soccer, the other sport quoting this table, takes the same path.
	outs, ok, why = Grade(mk, idx, "", 11625, ScoreSet{Main: fonbet.Score{Home: 4, Away: 4, Periods: [][2]int{{2, 2}, {2, 1}, {0, 1}}}, Shoot: &fonbet.Score{Home: 9, Away: 10}})
	if !ok || outs[1].Result != "1" {
		t.Fatalf("beach soccer shootout winner: %+v %v %s", outs, ok, why)
	}
}

func TestGradeTennisAndOT(t *testing.T) {
	idx := fixtureIndex()
	tennis := ScoreSet{Main: fonbet.Score{Home: 2, Away: 0, Periods: [][2]int{{6, 3}, {7, 5}}}}
	// games handicap on sum of periods: 13-8 = +5 → -3.5 wins
	outs, ok, why := Grade(Market{PMID: 1000304, TableNum: 304, Specs: map[string]string{"handicap": "-3.5"}, OutcomeIDs: []string{"h1", "h2"}}, idx, "", 4, tennis)
	if !ok || outs[0].Result != "1" {
		t.Fatalf("tennis games handicap: %+v %s", outs, why)
	}
	// games total 21 → 21.5 under
	outs, ok, _ = Grade(Market{PMID: 1000305, TableNum: 305, Specs: map[string]string{"threshold": "21.5"}, OutcomeIDs: []string{"over", "under"}}, idx, "", 4, tennis)
	if !ok || outs[1].Result != "1" {
		t.Fatalf("tennis games total: %+v", outs)
	}
	// winner by sets
	outs, ok, _ = Grade(Market{PMID: 1000120, TableNum: 120, Specs: map[string]string{}, OutcomeIDs: []string{"1", "2"}}, idx, "", 4, tennis)
	if !ok || outs[0].Result != "1" {
		t.Fatalf("tennis winner: %+v", outs)
	}
	// padel is tennis-shaped: "0:2 (3-6 4-6)" — games total 19, 1st set handicap on games
	padel := ScoreSet{Main: fonbet.Score{Home: 0, Away: 2, Periods: [][2]int{{3, 6}, {4, 6}}}}
	outs, ok, why = Grade(Market{PMID: 1000305, TableNum: 305, Specs: map[string]string{"threshold": "18.5"}, OutcomeIDs: []string{"over", "under"}}, idx, "", 17591, padel)
	if !ok || outs[0].Result != "1" {
		t.Fatalf("padel games total: %+v %s", outs, why)
	}
	outs, ok, why = Grade(Market{PMID: 1000304, TableNum: 304, Specs: map[string]string{"handicap": "2.5", "variant": "fb:100501"}, OutcomeIDs: []string{"h1", "h2"}}, idx, "1st set", 17591, padel)
	if !ok || outs[0].Result != "0" || outs[1].Result != "1" { // 3-6 +2.5 = -0.5 → away
		t.Fatalf("padel 1st set handicap: %+v %s", outs, why)
	}

	// basketball tied in regulation, decided in OT → two-way winner uses OT
	bb := ScoreSet{Main: fonbet.Score{Home: 80, Away: 80, Periods: [][2]int{{20, 20}, {20, 20}, {20, 20}, {20, 20}}}, OT: &fonbet.Score{Home: 5, Away: 9}}
	outs, ok, why = Grade(Market{PMID: 1000120, TableNum: 120, Specs: map[string]string{}, OutcomeIDs: []string{"1", "2"}}, idx, "", 3, bb)
	if !ok || outs[0].Result != "0" || outs[1].Result != "1" {
		t.Fatalf("basketball OT winner: %+v %s", outs, why)
	}
	// hockey two-way tie without OT row → left open
	hk := ScoreSet{Main: fonbet.Score{Home: 2, Away: 2, Periods: [][2]int{{1, 1}, {1, 1}, {0, 0}}}}
	if _, ok, _ = Grade(Market{PMID: 1000120, TableNum: 120, Specs: map[string]string{}, OutcomeIDs: []string{"1", "2"}}, idx, "", 2, hk); ok {
		t.Fatalf("tied two-way hockey must stay open")
	}
	// ... but a three-way winner settles as a draw
	outs, ok, _ = Grade(Market{PMID: 1000120, TableNum: 120, Specs: map[string]string{}, OutcomeIDs: []string{"1", "3", "2"}}, idx, "", 2, hk)
	if !ok || outs[2] != (Outcome{"3", "1", ""}) {
		t.Fatalf("hockey draw: %+v", outs)
	}
}

// Regression: for otIncluded sports scoreFor already folds the OT row into
// a two-way market's score. The tie-break must not add it a second time —
// the first cut did, and a game still level after the recorded overtime
// (100:102 + OT 3:1 = 103:103) came out 106:104, inventing a home win.
func TestGradeBasketballTiedAfterOTStaysOpen(t *testing.T) {
	idx := fixtureIndex()
	bb := ScoreSet{
		Main: fonbet.Score{Home: 100, Away: 102, Periods: [][2]int{{25, 25}, {25, 25}, {25, 26}, {25, 26}}},
		OT:   &fonbet.Score{Home: 3, Away: 1},
	}
	outs, ok, why := Grade(Market{PMID: 1000120, TableNum: 120, Specs: map[string]string{}, OutcomeIDs: []string{"1", "2"}}, idx, "", 3, bb)
	if ok {
		t.Fatalf("two-way basketball level after OT must stay open, got %+v", outs)
	}
	if why != "two-way market tied in main time" {
		t.Fatalf("unexpected reason %q", why)
	}
	// With a shootout row the tie is broken by it, OT still counted once.
	bb.Shoot = &fonbet.Score{Home: 0, Away: 1}
	outs, ok, why = Grade(Market{PMID: 1000120, TableNum: 120, Specs: map[string]string{}, OutcomeIDs: []string{"1", "2"}}, idx, "", 3, bb)
	if !ok || outs[0].Result != "0" || outs[1].Result != "1" {
		t.Fatalf("shootout after level OT: %+v %s", outs, why)
	}
	// Hockey (OT not included in the headline) still adds the OT row once
	// on the tie-break path.
	hk := ScoreSet{Main: fonbet.Score{Home: 2, Away: 2}, OT: &fonbet.Score{Home: 1, Away: 0}}
	outs, ok, why = Grade(Market{PMID: 1000120, TableNum: 120, Specs: map[string]string{}, OutcomeIDs: []string{"1", "2"}}, idx, "", 2, hk)
	if !ok || outs[0].Result != "1" || outs[1].Result != "0" {
		t.Fatalf("hockey OT winner: %+v %s", outs, why)
	}
}

// The 2026-09-06 sport rules, each against a real results-feed row.
func TestGradeNewSports(t *testing.T) {
	idx := fixtureIndex()
	total := func(line string, specs ...string) Market {
		m := Market{PMID: 1000305, TableNum: 305, Specs: map[string]string{"threshold": line}, OutcomeIDs: []string{"over", "under"}}
		for i := 0; i+1 < len(specs); i += 2 {
			m.Specs[specs[i]] = specs[i+1]
		}
		return m
	}
	hcp := func(line string) Market {
		return Market{PMID: 1000304, TableNum: 304, Specs: map[string]string{"handicap": line}, OutcomeIDs: []string{"h1", "h2"}}
	}
	winner3 := Market{PMID: 1000120, TableNum: 120, Specs: map[string]string{}, OutcomeIDs: []string{"1", "3", "2"}}
	winner2 := Market{PMID: 1000120, TableNum: 120, Specs: map[string]string{}, OutcomeIDs: []string{"1", "2"}}

	// Australian football: "141:88 (42-16 26-22 41-25 32-25)". Quarters are
	// periods, "1st half" is quarters 1+2 (68-38), regular time only.
	afl, _ := fonbet.ParseScore("141:88 (42-16 26-22 41-25 32-25)")
	ss := ScoreSet{Main: afl}
	if outs, ok, why := Grade(winner3, idx, "", 11638, ss); !ok || outs[0].Result != "1" || outs[2].Result != "0" {
		t.Fatalf("afl winner: %+v %v %s", outs, ok, why)
	}
	if outs, ok, why := Grade(total("105.5", "variant", "fb:100301"), idx, "1st half", 11638, ss); !ok || outs[0].Result != "1" { // 68+38 = 106
		t.Fatalf("afl 1st half total: %+v %v %s", outs, ok, why)
	}
	if outs, ok, why := Grade(hcp("-52.5"), idx, "3rd quarter", 11638, ss); !ok || outs[0].Result != "0" { // 41-25 = +16
		t.Fatalf("afl 3rd quarter handicap: %+v %v %s", outs, ok, why)
	}

	// Bandy: "4:4 (0-2 4-2)" — halves are periods, a draw is a draw.
	bandy, _ := fonbet.ParseScore("4:4 (0-2 4-2)")
	if outs, ok, why := Grade(winner3, idx, "", 10, ScoreSet{Main: bandy}); !ok || outs[2].Result != "1" {
		t.Fatalf("bandy draw: %+v %v %s", outs, ok, why)
	}
	if outs, ok, why := Grade(total("1.5", "variant", "fb:100201"), idx, "1st half", 10, ScoreSet{Main: bandy}); !ok || outs[0].Result != "1" { // 0+2
		t.Fatalf("bandy 1st half total: %+v %v %s", outs, ok, why)
	}

	// Beach soccer: "3:4 (2-1 0-1 1-2)" — three periods, headline is
	// regular time; a shootout row never leaks into a total.
	bs, _ := fonbet.ParseScore("4:4 (2-2 2-1 0-1 9-10)")
	bss := ScoreSet{Main: bs, Shoot: &fonbet.Score{Home: 9, Away: 10}}
	if outs, ok, why := Grade(total("7.5"), idx, "", 11625, bss); !ok || outs[0].Result != "1" || outs[1].Result != "0" { // 8 goals in regular time
		t.Fatalf("beach soccer total: %+v %v %s", outs, ok, why)
	}
	if outs, ok, why := Grade(total("2.5", "variant", "fb:100102"), idx, "2nd period", 11625, bss); !ok || outs[0].Result != "1" { // 2-1
		t.Fatalf("beach soccer 2nd period: %+v %v %s", outs, ok, why)
	}
	if outs, ok, why := Grade(winner3, idx, "", 11625, bss); !ok || outs[2].Result != "1" { // three-way: regular time draw
		t.Fatalf("beach soccer three-way draw: %+v %v %s", outs, ok, why)
	}

	// Darts: "2:6" is legs in a legs-format section; set play is refused.
	darts := ScoreSet{Main: fonbet.Score{Home: 2, Away: 6}, Section: "Darts. PDC. European Tour. Czech Republic. 2nd round. 11 legs"}
	if outs, ok, why := Grade(winner2, idx, "", 11632, darts); !ok || outs[1].Result != "1" {
		t.Fatalf("darts winner: %+v %v %s", outs, ok, why)
	}
	if outs, ok, why := Grade(hcp("2.5"), idx, "", 11632, darts); !ok || outs[0].Result != "0" || outs[1].Result != "1" { // 2+2.5-6 < 0
		t.Fatalf("darts legs handicap: %+v %v %s", outs, ok, why)
	}
	if outs, ok, why := Grade(total("8.5"), idx, "", 11632, darts); !ok || outs[1].Result != "1" { // 8 legs
		t.Fatalf("darts legs total: %+v %v %s", outs, ok, why)
	}
	darts.Section = "Darts. PDC. World Championship. Sets"
	if _, ok, why := Grade(total("8.5"), idx, "", 11632, darts); ok || why != "darts set-play format" {
		t.Fatalf("darts set play must be refused: ok=%v why=%q", ok, why)
	}
}

// Fight sports: the results feed scores a bout "<round>:0" / "0:<round>",
// the round the fight ended in on the winner's side (the distance for a
// decision).
func TestGradeFightSports(t *testing.T) {
	idx := fixtureIndex()
	winner3 := Market{PMID: 1000120, TableNum: 120, Specs: map[string]string{}, OutcomeIDs: []string{"1", "3", "2"}}
	dc := Market{PMID: 1900120, TableNum: 120, DoubleChance: true, Specs: map[string]string{}, OutcomeIDs: []string{"924", "1571", "925"}}
	total := func(line string) Market {
		return Market{PMID: 1000305, TableNum: 305, Specs: map[string]string{"threshold": line}, OutcomeIDs: []string{"over", "under"}}
	}
	for _, sport := range []int{37145, 1436} {
		// Home won in round 2: winner 1, draw lost; DC 1X and 12 win, X2 loses.
		r2 := ScoreSet{Main: fonbet.Score{Home: 2, Away: 0}}
		outs, ok, why := Grade(winner3, idx, "", sport, r2)
		if !ok || outs[0] != (Outcome{"1", "1", ""}) || outs[1] != (Outcome{"2", "0", ""}) || outs[2] != (Outcome{"3", "0", ""}) {
			t.Fatalf("sport %d winner: %+v %v %s", sport, outs, ok, why)
		}
		outs, ok, why = Grade(dc, idx, "", sport, r2)
		if !ok || outs[0] != (Outcome{"1571", "1", ""}) || outs[1] != (Outcome{"924", "1", ""}) || outs[2] != (Outcome{"925", "0", ""}) {
			t.Fatalf("sport %d double chance: %+v %v %s", sport, outs, ok, why)
		}
		// Total rounds 1.5 with a round-2 finish: the fight ended in the
		// deciding round and the feed has no clock — refused. 2.5 → under
		// (ended before round 3). 0.5 → over.
		if _, ok, why := Grade(total("1.5"), idx, "", sport, r2); ok || why != "fight ended in the deciding round" {
			t.Fatalf("sport %d total 1.5 in a round-2 finish: ok=%v why=%q", sport, ok, why)
		}
		if outs, ok, why := Grade(total("2.5"), idx, "", sport, r2); !ok || outs[0].Result != "0" || outs[1].Result != "1" {
			t.Fatalf("sport %d total 2.5: %+v %v %s", sport, outs, ok, why)
		}
		if outs, ok, why := Grade(total("0.5"), idx, "", sport, r2); !ok || outs[0].Result != "1" {
			t.Fatalf("sport %d total 0.5: %+v %v %s", sport, outs, ok, why)
		}
		// "0:12" — a 12-round decision for the away corner: over 9.5.
		dist := ScoreSet{Main: fonbet.Score{Home: 0, Away: 12}}
		if outs, ok, why := Grade(winner3, idx, "", sport, dist); !ok || outs[1].Result != "1" {
			t.Fatalf("sport %d decision winner: %+v %v %s", sport, outs, ok, why)
		}
		if outs, ok, why := Grade(total("9.5"), idx, "", sport, dist); !ok || outs[0].Result != "1" {
			t.Fatalf("sport %d over 9.5 on the distance: %+v %v %s", sport, outs, ok, why)
		}
		// Whole-number line: a finish in round 3 against "3" is refused
		// (finish vs distance cannot be told apart), round 4 is over.
		if _, ok, why := Grade(total("3"), idx, "", sport, ScoreSet{Main: fonbet.Score{Home: 3, Away: 0}}); ok || why != "fight ended in the deciding round" {
			t.Fatalf("sport %d total 3 with a round-3 result: ok=%v why=%q", sport, ok, why)
		}
		if outs, ok, why := Grade(total("3"), idx, "", sport, ScoreSet{Main: fonbet.Score{Home: 0, Away: 4}}); !ok || outs[0].Result != "1" {
			t.Fatalf("sport %d total 3 with a round-4 result: %+v %v %s", sport, outs, ok, why)
		}
		// No winner recorded: draw, no contest or unknown — refused.
		if _, ok, why := Grade(winner3, idx, "", sport, ScoreSet{Main: fonbet.Score{}}); ok || why != "fight result undecided" {
			t.Fatalf("sport %d 0:0 must be refused: ok=%v why=%q", sport, ok, why)
		}
		// Handicaps have no scorecards behind them.
		if _, ok, why := Grade(Market{PMID: 1000304, TableNum: 304, Specs: map[string]string{"handicap": "-1.5"}, OutcomeIDs: []string{"h1", "h2"}}, idx, "", sport, r2); ok || why != "fight handicap" {
			t.Fatalf("sport %d handicap must be refused: ok=%v why=%q", sport, ok, why)
		}
	}
	// A statistic row (boxing "knockeddowns: Total") is ordinary arithmetic.
	box := ScoreSet{Main: fonbet.Score{Home: 0, Away: 12}, Stats: map[string]fonbet.Score{"knockeddowns": {Home: 0, Away: 1}}}
	outs, ok, why := Grade(Market{PMID: 1000305, TableNum: 305, Specs: map[string]string{"threshold": "0.5", "variant": "fb:470100"}, OutcomeIDs: []string{"over", "under"}}, idx, "knockeddowns", 1436, box)
	if !ok || outs[0].Result != "1" {
		t.Fatalf("knockdowns total: %+v %v %s", outs, ok, why)
	}
}
