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
	if _, ok := fonbet.ParseScore("отменён"); ok {
		t.Fatalf("text score must not parse")
	}
	s, _ = fonbet.ParseScore("2:4")
	if s.Home != 2 || s.Away != 4 || len(s.Periods) != 0 {
		t.Fatalf("plain score: %+v", s)
	}
}

func TestParseLabel(t *testing.T) {
	cases := map[string]labelTarget{
		"1-й тайм":         {period: 1},
		"2-й тайм угловые": {period: 2, stat: "угловые"},
		"угловые":          {stat: "угловые"},
		"1-й сет":          {period: 1},
		"1-я половина":     {half: 1},
		"3-я четверть":     {period: 3},
	}
	for in, want := range cases {
		if got := parseLabel(in); got != want {
			t.Errorf("parseLabel(%q) = %+v, want %+v", in, got, want)
		}
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
		{2, 1, -1.25, gHalfWon, gHalfLost}, // -1 push + -1.5 loss? no: 2-1=1: -1 → push, -1.5 → loss → half lost
		{2, 0, -1.75, gHalfWon, gHalfLost}, // -1.5 win, -2 push
		{0, 2, 1.75, gHalfLost, gHalfWon},  // +1.5 loss, +2 push
		{0, 0, 0.25, gHalfWon, gHalfLost},  // 0 push + 0.5 win
	} {
		r1, r2 := gradeHandicap(tc.h, tc.a, tc.line)
		// the -1.25 case: 2-1 with -1 = push, with -1.5 = loss → half lost for h1
		if tc.line == -1.25 {
			tc.r1, tc.r2 = gHalfLost, gHalfWon
		}
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

func fixtureIndex() *fonbet.Index {
	cat := &fonbet.Catalog{Groups: []fonbet.Group{{Name: "Основные ставки", Tables: []fonbet.Table{
		{Num: 120, Name: "Исходы", IsMain: true, Rows: [][]fonbet.Cell{
			{{Name: "1"}, {Name: "X"}, {Name: "2"}, {Name: "1X"}, {Name: "12"}, {Name: "X2"}},
			{{Kind: "value", FactorID: 921}, {Kind: "value", FactorID: 922}, {Kind: "value", FactorID: 923}, {Kind: "value", FactorID: 924}, {Kind: "value", FactorID: 1571}, {Kind: "value", FactorID: 925}},
		}},
		{Num: 304, Name: "Фора", IsMain: true, Rows: [][]fonbet.Cell{
			{{Name: ""}, {Name: "1"}, {Name: ""}, {Name: "2"}},
			{{Kind: "param", FactorID: 910}, {Kind: "value", FactorID: 910}, {Kind: "param", FactorID: 912}, {Kind: "value", FactorID: 912}},
		}},
		{Num: 305, Name: "Тотал", IsMain: true, Rows: [][]fonbet.Cell{
			{{Name: ""}, {Name: "Б"}, {Name: "М"}},
			{{Kind: "param", FactorID: 930}, {Kind: "value", FactorID: 930}, {Kind: "value", FactorID: 931}},
		}},
		{Num: 400, Name: "Исход с учетом ОТ", IsMain: true, Rows: [][]fonbet.Cell{
			{{Name: "1"}, {Name: "2"}},
			{{Kind: "value", FactorID: 5001}, {Kind: "value", FactorID: 5002}},
		}},
	}}}}
	return fonbet.BuildIndex(cat)
}

func TestGradeFootball(t *testing.T) {
	idx := fixtureIndex()
	ss := ScoreSet{Main: fonbet.Score{Home: 2, Away: 1, Periods: [][2]int{{1, 1}, {1, 0}}},
		Stats: map[string]fonbet.Score{"угловые": {Home: 8, Away: 2, Periods: [][2]int{{3, 2}, {5, 0}}}}}

	outs, ok, why := Grade(Market{PMID: 1000120, Specs: map[string]string{}, OutcomeIDs: []string{"1", "3", "2"}}, idx, "", 1, ss)
	if !ok || len(outs) != 3 || outs[0] != (Outcome{"1", "1", ""}) || outs[1] != (Outcome{"2", "0", ""}) || outs[2] != (Outcome{"3", "0", ""}) {
		t.Fatalf("winner: %+v %v %s", outs, ok, why)
	}
	outs, ok, _ = Grade(Market{PMID: 1900120, Specs: map[string]string{}, OutcomeIDs: []string{"924", "1571", "925"}}, idx, "", 1, ss)
	if !ok || outs[0] != (Outcome{"1571", "1", ""}) || outs[1] != (Outcome{"924", "1", ""}) || outs[2] != (Outcome{"925", "0", ""}) {
		t.Fatalf("double chance: %+v", outs)
	}
	outs, ok, _ = Grade(Market{PMID: 1000304, Specs: map[string]string{"handicap": "-0.5"}, OutcomeIDs: []string{"h1", "h2"}}, idx, "", 1, ss)
	if !ok || outs[0] != (Outcome{"h1", "1", ""}) || outs[1] != (Outcome{"h2", "0", ""}) {
		t.Fatalf("handicap: %+v", outs)
	}
	// 1st half total 2.5 → 2 goals → under
	outs, ok, _ = Grade(Market{PMID: 1000305, Specs: map[string]string{"threshold": "2.5", "variant": "fb:100201"}, OutcomeIDs: []string{"over", "under"}}, idx, "1-й тайм", 1, ss)
	if !ok || outs[0] != (Outcome{"over", "0", ""}) || outs[1] != (Outcome{"under", "1", ""}) {
		t.Fatalf("half total: %+v", outs)
	}
	// 1st-half winner keeps factor ids and double-chance cells: 1-1 → X, 1X, X2 win
	outs, ok, why = Grade(Market{PMID: 1000120, Specs: map[string]string{"variant": "fb:100201"}, OutcomeIDs: []string{"921", "922", "923", "924", "1571", "925"}}, idx, "1-й тайм", 1, ss)
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
	outs, ok, _ = Grade(Market{PMID: 1000305, Specs: map[string]string{"threshold": "9.5", "variant": "fb:400100"}, OutcomeIDs: []string{"over", "under"}}, idx, "угловые", 1, ss)
	if !ok || outs[0] != (Outcome{"over", "1", ""}) {
		t.Fatalf("corners: %+v", outs)
	}
	// home team total (side)
	outs, ok, _ = Grade(Market{PMID: 1000305, Specs: map[string]string{"threshold": "1.5", "side": "home"}, OutcomeIDs: []string{"over", "under"}}, idx, "", 1, ss)
	if !ok || outs[0] != (Outcome{"over", "1", ""}) {
		t.Fatalf("team total: %+v", outs)
	}
	// OT table is skipped, unknown sport is skipped, missing stat is skipped
	if _, ok, _ = Grade(Market{PMID: 1000400, Specs: map[string]string{}, OutcomeIDs: []string{"5001", "5002"}}, idx, "", 2, ss); ok {
		t.Fatalf("OT table must be skipped")
	}
	if _, ok, _ = Grade(Market{PMID: 1000120, Specs: map[string]string{}, OutcomeIDs: []string{"1", "3", "2"}}, idx, "", 11632, ss); ok {
		t.Fatalf("darts must be skipped")
	}
	if _, ok, _ = Grade(Market{PMID: 1000305, Specs: map[string]string{"threshold": "4.5", "variant": "fb:1"}, OutcomeIDs: []string{"over", "under"}}, idx, "желтые карты", 1, ss); ok {
		t.Fatalf("missing stat row must be skipped")
	}
}

func TestGradeTennisAndOT(t *testing.T) {
	idx := fixtureIndex()
	tennis := ScoreSet{Main: fonbet.Score{Home: 2, Away: 0, Periods: [][2]int{{6, 3}, {7, 5}}}}
	// games handicap on sum of periods: 13-8 = +5 → -3.5 wins
	outs, ok, why := Grade(Market{PMID: 1000304, Specs: map[string]string{"handicap": "-3.5"}, OutcomeIDs: []string{"h1", "h2"}}, idx, "", 4, tennis)
	if !ok || outs[0].Result != "1" {
		t.Fatalf("tennis games handicap: %+v %s", outs, why)
	}
	// games total 21 → 21.5 under
	outs, ok, _ = Grade(Market{PMID: 1000305, Specs: map[string]string{"threshold": "21.5"}, OutcomeIDs: []string{"over", "under"}}, idx, "", 4, tennis)
	if !ok || outs[1].Result != "1" {
		t.Fatalf("tennis games total: %+v", outs)
	}
	// winner by sets
	outs, ok, _ = Grade(Market{PMID: 1000120, Specs: map[string]string{}, OutcomeIDs: []string{"1", "2"}}, idx, "", 4, tennis)
	if !ok || outs[0].Result != "1" {
		t.Fatalf("tennis winner: %+v", outs)
	}

	// basketball tied in regulation, decided in OT → two-way winner uses OT
	bb := ScoreSet{Main: fonbet.Score{Home: 80, Away: 80, Periods: [][2]int{{20, 20}, {20, 20}, {20, 20}, {20, 20}}}, OT: &fonbet.Score{Home: 5, Away: 9}}
	outs, ok, why = Grade(Market{PMID: 1000120, Specs: map[string]string{}, OutcomeIDs: []string{"1", "2"}}, idx, "", 3, bb)
	if !ok || outs[0].Result != "0" || outs[1].Result != "1" {
		t.Fatalf("basketball OT winner: %+v %s", outs, why)
	}
	// hockey two-way tie without OT row → left open
	hk := ScoreSet{Main: fonbet.Score{Home: 2, Away: 2, Periods: [][2]int{{1, 1}, {1, 1}, {0, 0}}}}
	if _, ok, _ = Grade(Market{PMID: 1000120, Specs: map[string]string{}, OutcomeIDs: []string{"1", "2"}}, idx, "", 2, hk); ok {
		t.Fatalf("tied two-way hockey must stay open")
	}
	// ... but a three-way winner settles as a draw
	outs, ok, _ = Grade(Market{PMID: 1000120, Specs: map[string]string{}, OutcomeIDs: []string{"1", "3", "2"}}, idx, "", 2, hk)
	if !ok || outs[2] != (Outcome{"3", "1", ""}) {
		t.Fatalf("hockey draw: %+v", outs)
	}
}
