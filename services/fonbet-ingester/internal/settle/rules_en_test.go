// Grader coverage for the English line. FONBET_LANG defaults to "en", so
// the catalogue table names, the sub-event labels and the results-feed
// statistic rows all arrive in English and rules.go has to recognise them
// as well as it recognises the Russian ones. Every string below is a
// verbatim label from the live fon.bet line or its results feed
// (2026-09-04), paired against its Russian counterpart by event / row id.

package settle

import (
	"testing"

	"github.com/oddzilla/fonbet-ingester/internal/fonbet"
)

func TestParseLabelEnglish(t *testing.T) {
	// sport is only consulted for "half", which English does not
	// distinguish: Russian "тайм" (one period) and "половина" (two
	// periods) are both "1st half".
	const football, basketball, hockey, tableTennis = 1, 3, 2, 3088
	cases := []struct {
		label string
		sport int
		want  labelTarget
		ok    bool
	}{
		// Prefix form.
		{"1st half", football, labelTarget{period: 1}, true},
		{"2nd half", football, labelTarget{period: 2}, true},
		{"1st half corners", football, labelTarget{period: 1, stat: "corners"}, true},
		{"1st period", hockey, labelTarget{period: 1}, true},
		{"3rd period power play goals", hockey, labelTarget{period: 3, stat: "power play goals"}, true},
		{"1st set", tableTennis, labelTarget{period: 1}, true},
		{"2nd set aces", tableTennis, labelTarget{period: 2, stat: "aces"}, true},
		{"1st quarter", basketball, labelTarget{period: 1}, true},
		{"1st inning", 5, labelTarget{period: 1}, true},
		// Suffix form: English moves some statistic rows to the front.
		{"Yellow cards — 1st half", football, labelTarget{period: 1, stat: "yellow cards"}, true},
		{"Fouls — 1st half", football, labelTarget{period: 1, stat: "fouls"}, true},
		{"medical treatment received on the pitch - 1st half", football,
			labelTarget{period: 1, stat: "medical treatment received on the pitch"}, true},
		// Whole-match statistic rows carry no period marker.
		{"Corners", football, labelTarget{stat: "corners"}, true},
		{"extra time", football, labelTarget{stat: "extra time"}, true},
		// "Nth half" resolves per sport: basketball plays two quarters per
		// half, football numbers its halves as periods.
		{"1st half", basketball, labelTarget{half: 1}, true},
		{"2nd half", basketball, labelTarget{half: 2}, true},
		// Sports with neither convention refuse rather than guess.
		{"1st half", hockey, labelTarget{}, false},
		{"1st half", 47041, labelTarget{}, false},
		// Aggregate specials and prop markets parse a period but keep a
		// statistic name the results feed does not carry, so scoreFor
		// leaves them open — same as in Russian, where they never matched
		// the period prefix at all.
		{"8 matches 1st half", football, labelTarget{period: 1, stat: "8 matches"}, true},
		{"Red card in the 1st half", football, labelTarget{period: 1, stat: "red card in the"}, true},
		{"Penalty in the 2nd half", football, labelTarget{period: 2, stat: "penalty in the"}, true},
		{"Match to be finished in tie-break of 5th set", tableTennis,
			labelTarget{period: 5, stat: "match to be finished in tie-break of"}, true},
		// Plural "innings" is Fonbet's cumulative "first N innings" row,
		// not the Nth one, so it must NOT parse as a period.
		{"5 innings", 5, labelTarget{stat: "5 innings"}, true},
		{"2nd innings", 5, labelTarget{stat: "2nd innings"}, true},
	}
	for _, tc := range cases {
		got, ok := resolveHalf(parseLabel(tc.label), tc.sport)
		if ok != tc.ok {
			t.Errorf("resolveHalf(%q, sport %d) ok = %v, want %v", tc.label, tc.sport, ok, tc.ok)
			continue
		}
		if ok && got != tc.want {
			t.Errorf("parse %q (sport %d) = %+v, want %+v", tc.label, tc.sport, got, tc.want)
		}
	}
}

// TestTableUnsafeEnglish pins the shapes the grader must refuse by name.
// The English names on the left are the ones the Russian words used to
// miss; a threshold table called "Total missed penalties" looks exactly
// like an ordinary over/under to the shape checks, so the name guard is
// the only thing standing between it and a settlement off the goal score.
func TestTableUnsafeEnglish(t *testing.T) {
	unsafe := []string{
		"Total missed penalties",
		"Team total missed penalties",
		"Result in overtime",
		"Including overtime",
		"Who will start the penalty shootout",
		"Penalty shootouts (first 5 shots each team)",
		"Total best-of-five penalties (5 shots each)",
		"Correct score",
		"Odd/even",
		"Series handicap",
		"Series total",
		"To win the series",
		"Minute of the first goal",
		// The Russian names stay covered: the catalogue is read in
		// whatever language FONBET_LANG asked for.
		"Тотал незабитых пенальти",
		"Результат в овертайме",
		"Точный счёт",
		"Тотал серии",
		"Исход основной серии (по 5 ударов)",
	}
	for _, name := range unsafe {
		if !tableUnsafe(&fonbet.TableMeta{Name: name}) {
			t.Errorf("tableUnsafe(%q) = false, want true", name)
		}
	}
	// Ordinary markets must stay gradable — an over-eager guard turns
	// every settlement into manual work.
	safe := []string{
		"1X2", "Handicap", "Total", "Team total", "Double chance",
		"Total corners", "Yellow cards total", "Result",
		"Тотал", "Фора", "Двойной шанс", "Тотал угловых",
	}
	for _, name := range safe {
		if tableUnsafe(&fonbet.TableMeta{Name: name}) {
			t.Errorf("tableUnsafe(%q) = true, want false", name)
		}
	}
}

// TestGradeEnglishHalfAndStat walks a full English label through Grade to
// prove the period and statistic targets land on the same score the
// Russian labels do.
func TestGradeEnglishHalfAndStat(t *testing.T) {
	idx := &fonbet.Index{Tables: map[int]*fonbet.TableMeta{}, Factors: map[int]*fonbet.FactorMeta{}}
	total := &fonbet.TableMeta{Num: 1, Name: "Total", Param: fonbet.ParamThreshold}
	idx.Tables[1] = total

	// Football 2:1 (1-0 1-1), corners 9:4 (5-2 4-2).
	corners, _ := fonbet.ParseScore("9:4 (5-2 4-2)")
	main, _ := fonbet.ParseScore("2:1 (1-0 1-1)")
	ss := ScoreSet{Main: main, Stats: map[string]fonbet.Score{"corners": corners}}
	mk := Market{PMID: 1000001, Specs: map[string]string{"threshold": "6.5"}, OutcomeIDs: []string{"over", "under"}}

	// "1st half corners" = 5+2 = 7 corners, over 6.5 wins.
	outs, ok, why := Grade(mk, idx, "1st half corners", 1, ss)
	if !ok {
		t.Fatalf("1st half corners: %s", why)
	}
	if outs[0].ID != "over" || outs[0].Result != "1" {
		t.Fatalf("1st half corners over 6.5: %+v", outs)
	}
	// "1st half" alone = 1+0 = 1 goal, under 6.5 wins.
	outs, ok, why = Grade(mk, idx, "1st half", 1, ss)
	if !ok {
		t.Fatalf("1st half: %s", why)
	}
	if outs[1].ID != "under" || outs[1].Result != "1" {
		t.Fatalf("1st half under 6.5: %+v", outs)
	}
	// The same label on ice hockey has no known meaning and must not be
	// graded on a guess.
	if _, ok, why = Grade(mk, idx, "1st half", 2, ss); ok || why != "ambiguous half label" {
		t.Fatalf("hockey 1st half: ok=%v why=%q", ok, why)
	}
	// Basketball: "1st half" spans two quarters. 20+18 = 38 points.
	bball, _ := fonbet.ParseScore("80:75 (20-18 18-20 21-19 21-18)")
	bss := ScoreSet{Main: bball}
	bmk := Market{PMID: 1000001, Specs: map[string]string{"threshold": "37.5"}, OutcomeIDs: []string{"over", "under"}}
	outs, ok, why = Grade(bmk, idx, "1st half", 3, bss)
	if !ok {
		t.Fatalf("basketball 1st half: %s", why)
	}
	if outs[0].ID != "over" || outs[0].Result != "1" {
		t.Fatalf("basketball 1st half over 37.5 (should be 38): %+v", outs)
	}
}

// TestGradeEnglishOvertimeRow proves the English "extra time" row breaks a
// tie the same way the Russian "дополнительное время" one does. Without
// it a two-way market level after regular time would either grade as a
// loss for both sides or, on an otIncluded sport, settle on regular time.
func TestGradeEnglishOvertimeRow(t *testing.T) {
	for _, row := range []string{"extra time", "дополнительное время"} {
		main, _ := fonbet.ParseScore("2:2 (1-1 1-1)")
		ot, _ := fonbet.ParseScore("1:0")
		stats := map[string]fonbet.Score{row: ot}
		ss := ScoreSet{Main: main, Stats: stats}
		for _, k := range overtimeRows {
			if v, ok := stats[k]; ok {
				ss.OT = &v
			}
		}
		if ss.OT == nil {
			t.Fatalf("%q not recognised as an overtime row", row)
		}
		idx := &fonbet.Index{
			Tables:  map[int]*fonbet.TableMeta{1: {Num: 1, Name: "Result", IsMain: true, IsMatchWinner: true}},
			Factors: map[int]*fonbet.FactorMeta{},
		}
		mk := Market{PMID: 1000001, Specs: map[string]string{}, OutcomeIDs: []string{"1", "2"}}
		outs, ok, why := Grade(mk, idx, "", 8, ss)
		if !ok {
			t.Fatalf("%q: %s", row, why)
		}
		if outs[0].ID != "1" || outs[0].Result != "1" {
			t.Fatalf("%q: home should win after overtime: %+v", row, outs)
		}
	}
}
