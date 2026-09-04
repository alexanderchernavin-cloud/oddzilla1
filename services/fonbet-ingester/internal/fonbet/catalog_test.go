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
	if got := idx.Factors[930]; got == nil || got.Label != "Б" {
		t.Fatalf("factor 930: %+v", got)
	}
	if got := idx.Factors[931]; got == nil || got.Label != "М" {
		t.Fatalf("factor 931: %+v", got)
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
