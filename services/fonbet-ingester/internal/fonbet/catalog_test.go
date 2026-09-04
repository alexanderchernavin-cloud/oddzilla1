package fonbet

import (
	"encoding/json"
	"os"
	"testing"
)

func TestBuildIndexFromFixture(t *testing.T) {
	raw, err := os.ReadFile("../mapper/testdata/catalog_small.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var cat Catalog
	if err := json.Unmarshal(raw, &cat); err != nil {
		t.Fatalf("decode: %v", err)
	}
	idx := BuildIndex(&cat)

	mw := idx.Tables[120]
	if mw == nil || !mw.IsMatchWinner || mw.Param != ParamNone || mw.Name != "Исходы" {
		t.Fatalf("table 120: %+v", mw)
	}
	for f, want := range map[int]string{921: "1", 922: "3", 923: "2"} {
		if got := idx.Factors[f]; got == nil || got.WinnerOutcome != want {
			t.Fatalf("factor %d winner outcome: %+v", f, got)
		}
	}
	for _, f := range []int{924, 1571, 925} {
		if got := idx.Factors[f]; got == nil || !got.DoubleChance {
			t.Fatalf("factor %d should be double chance: %+v", f, got)
		}
	}

	h := idx.Tables[304]
	if h == nil || h.Param != ParamHandicap || h.Param.SpecifierKey() != "handicap" {
		t.Fatalf("table 304: %+v", h)
	}
	f910 := idx.Factors[910]
	if f910 == nil || f910.Label != "1" || f910.Table != h {
		t.Fatalf("factor 910: %+v", f910)
	}
	row := f910.RowFactors()
	if len(row) != 2 || row[0] != 910 || row[1] != 912 {
		t.Fatalf("row factors for 910: %v", row)
	}

	tt := idx.Tables[305]
	if tt == nil || tt.Param != ParamThreshold || tt.Param.SpecifierKey() != "threshold" {
		t.Fatalf("table 305: %+v", tt)
	}
	// The fixture is the Russian catalogue, whose total columns are
	// captioned "Б" / "М". Those are expanded to words for the label
	// (the storefront renders each cell on its own, with no column head
	// to read them under) while the side id stays the canonical form.
	if got := idx.Factors[930]; got == nil || got.Label != "Больше" || got.SideID != "over" {
		t.Fatalf("factor 930: %+v", got)
	}
	if got := idx.Factors[931]; got == nil || got.Label != "Меньше" || got.SideID != "under" {
		t.Fatalf("factor 931: %+v", got)
	}
}

// TestTotalCaptionsExpand pins the over / under column captions of a total
// table to full words in both languages. Fonbet's English catalogue
// captions them "O" / "U", which is the entire outcome label on the
// storefront once each cell is rendered on its own row.
func TestTotalCaptionsExpand(t *testing.T) {
	total := Table{
		Num: 305, Name: "Total", IsMain: true,
		Rows: [][]Cell{
			{{Name: ""}, {Name: "O"}, {Name: "U"}},
			{{Kind: "param", FactorID: 930}, {Kind: "value", FactorID: 930}, {Kind: "value", FactorID: 931}},
		},
	}
	en := BuildIndex(&Catalog{Lang: "en", Groups: []Group{{Name: "Main bets", Tables: []Table{total}}}})
	if got := en.Factors[930]; got == nil || got.Label != "Over" || got.SideID != "over" {
		t.Fatalf("en over: %+v", got)
	}
	if got := en.Factors[931]; got == nil || got.Label != "Under" || got.SideID != "under" {
		t.Fatalf("en under: %+v", got)
	}

	// A row caption keeps its place ahead of the expanded column word.
	ru := Table{
		Num: 12002, Name: "Показатели",
		Rows: [][]Cell{
			{{Name: "Показатели"}, {Name: "Тотал"}, {Name: "Б"}, {Name: "М"}},
			{{Name: "Тай-брейки"}, {Kind: "param", FactorID: 671}, {Kind: "value", FactorID: 671}, {Kind: "value", FactorID: 673}},
		},
	}
	ruIdx := BuildIndex(&Catalog{Lang: "ru", Groups: []Group{{Name: "Дополнительные ставки", Tables: []Table{ru}}}})
	if got := ruIdx.Factors[671]; got == nil || got.Label != "Тай-брейки Больше" {
		t.Fatalf("ru row+column label: %+v", got)
	}

	// Captions with no expansion are untouched: team sides on a handicap
	// table, yes/no, correct scores.
	hcp := Table{
		Num: 304, Name: "Handicap", IsMain: true,
		Rows: [][]Cell{
			{{Name: ""}, {Name: "1"}, {Name: ""}, {Name: "2"}},
			{{Kind: "param", FactorID: 910}, {Kind: "value", FactorID: 910}, {Kind: "param", FactorID: 912}, {Kind: "value", FactorID: 912}},
		},
	}
	hIdx := BuildIndex(&Catalog{Lang: "en", Groups: []Group{{Name: "Main bets", Tables: []Table{hcp}}}})
	if got := hIdx.Factors[910]; got == nil || got.Label != "1" {
		t.Fatalf("handicap home caption: %+v", got)
	}
	if got := hIdx.Factors[912]; got == nil || got.Label != "2" {
		t.Fatalf("handicap away caption: %+v", got)
	}
}

func TestHeaderDetection(t *testing.T) {
	cat := &Catalog{Groups: []Group{{Name: "Основные ставки", Tables: []Table{{
		Num: 7, Name: "Да/Нет", IsMain: false,
		Rows: [][]Cell{
			{{Name: "Да"}, {Name: "Нет"}},
			{{Kind: "value", FactorID: 11}, {Kind: "value", FactorID: 12}},
		},
	}, {
		Num: 8, Name: "Без шапки",
		Rows: [][]Cell{
			{{Name: "2-0"}, {Kind: "value", FactorID: 21}},
		},
	}}}}}
	idx := BuildIndex(cat)
	if idx.Factors[11].Label != "Да" || idx.Factors[12].Label != "Нет" {
		t.Fatalf("labels: %+v %+v", idx.Factors[11], idx.Factors[12])
	}
	if idx.Tables[7].IsMatchWinner {
		t.Fatalf("yes/no must not be a match winner")
	}
	if idx.Factors[21].Label != "2-0" || len(idx.Tables[8].Header) != 0 {
		t.Fatalf("headerless table: %+v", idx.Factors[21])
	}
}
