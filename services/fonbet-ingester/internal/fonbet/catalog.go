// Factor catalogue index. Fonbet prices "factors" (numeric outcome ids)
// and describes them separately through factorsCatalog/tables: every
// table is one market layout, every row one line of that market, every
// "value" cell one priced factor. This file turns that layout into a
// per-factor lookup the mapper uses to build oddzilla markets.

package fonbet

import (
	"strconv"
	"strings"
)

// ParamKind says how a table is parameterised.
type ParamKind int

const (
	ParamNone      ParamKind = iota // plain market (1X2, correct score, yes/no)
	ParamHandicap                   // two param cells per row: side 1 gets -x, side 2 gets +x
	ParamThreshold                  // one param cell per row: over / under the same line
)

// SpecifierKey is the oddzilla specifier name the storefront treats as a
// "line" (services/api catalog LINE_SPECIFIERS).
func (k ParamKind) SpecifierKey() string {
	switch k {
	case ParamHandicap:
		return "handicap"
	case ParamThreshold:
		return "threshold"
	}
	return ""
}

// TableMeta is one Fonbet market layout.
type TableMeta struct {
	Num           int
	Name          string
	Group         string
	IsMain        bool
	Param         ParamKind
	Side          string // "home" / "away" for the per-team groups (%1 / %2), else ""
	IsMatchWinner bool   // isMain 1/X/2 table → outcome ids 1/2/3 for the list cards
	Header        []string
	Rows          [][]int // value factor ids per data row, column order
}

// FactorMeta is one priced outcome.
type FactorMeta struct {
	FactorID      int
	Table         *TableMeta
	Row           int // index into Table.Rows
	Label         string
	WinnerOutcome string // "1" | "2" | "3" on match-winner tables
	DoubleChance  bool   // 1X / 12 / X2 cells of a match-winner table
}

// RowFactors returns every value factor on the same line as this factor.
func (m *FactorMeta) RowFactors() []int {
	if m.Row < 0 || m.Row >= len(m.Table.Rows) {
		return nil
	}
	return m.Table.Rows[m.Row]
}

// Index is the decoded catalogue for one language.
type Index struct {
	Lang    string
	Factors map[int]*FactorMeta
	Tables  map[int]*TableMeta
}

var matchWinnerCaptions = map[string]string{
	"1": "1", "2": "2", "X": "3", "Х": "3", // latin X and cyrillic Х both appear
}
var doubleChanceCaptions = map[string]struct{}{
	"1X": {}, "12": {}, "X2": {}, "1Х": {}, "Х2": {},
}

// BuildIndex flattens the catalogue. First definition of a factor wins
// (the catalogue never repeats a factor across tables in practice).
func BuildIndex(cat *Catalog) *Index {
	idx := &Index{Lang: cat.Lang, Factors: map[int]*FactorMeta{}, Tables: map[int]*TableMeta{}}
	for _, g := range cat.Groups {
		group := strings.TrimSpace(g.Name)
		for ti := range g.Tables {
			t := &g.Tables[ti]
			if len(t.Rows) == 0 {
				continue
			}
			if _, dup := idx.Tables[t.Num]; dup {
				continue
			}
			tm := &TableMeta{
				Num:    t.Num,
				Name:   strings.TrimSpace(t.Name),
				Group:  group,
				IsMain: t.IsMain,
			}
			switch group {
			case "%1":
				tm.Side = "home"
			case "%2":
				tm.Side = "away"
			}
			rows := t.Rows
			if isHeaderRow(rows[0]) {
				for _, c := range rows[0] {
					tm.Header = append(tm.Header, strings.TrimSpace(c.Name))
				}
				rows = rows[1:]
			}
			// Parameterisation: count param cells per data row.
			maxParams := 0
			for _, r := range rows {
				n := 0
				for _, c := range r {
					if c.Kind == "param" {
						n++
					}
				}
				if n > maxParams {
					maxParams = n
				}
			}
			switch {
			case maxParams >= 2:
				tm.Param = ParamHandicap
			case maxParams == 1:
				tm.Param = ParamThreshold
			}
			tm.IsMatchWinner = tm.IsMain && tm.Param == ParamNone && len(rows) == 1 && isMatchWinnerHeader(tm.Header)

			for ri, r := range rows {
				rowLabel := ""
				for _, c := range r {
					if c.Kind == "" && c.Name != "" {
						rowLabel = strings.TrimSpace(c.Name)
					}
				}
				var rowFactors []int
				for ci, c := range r {
					if c.Kind != "value" || c.FactorID == 0 {
						continue
					}
					rowFactors = append(rowFactors, c.FactorID)
					if _, dup := idx.Factors[c.FactorID]; dup {
						continue
					}
					col := ""
					if ci < len(tm.Header) {
						col = tm.Header[ci]
					}
					label := strings.TrimSpace(strings.TrimSpace(rowLabel + " " + col))
					if label == "" {
						label = strconv.Itoa(c.FactorID)
					}
					fm := &FactorMeta{FactorID: c.FactorID, Table: tm, Row: ri, Label: label}
					if tm.IsMatchWinner {
						if w, ok := matchWinnerCaptions[col]; ok {
							fm.WinnerOutcome = w
						} else if _, ok := doubleChanceCaptions[col]; ok {
							fm.DoubleChance = true
						}
					}
					idx.Factors[c.FactorID] = fm
				}
				tm.Rows = append(tm.Rows, rowFactors)
			}
			idx.Tables[t.Num] = tm
		}
	}
	return idx
}

func isHeaderRow(r []Cell) bool {
	if len(r) == 0 {
		return false
	}
	for _, c := range r {
		if c.Kind != "" {
			return false
		}
	}
	return true
}

func isMatchWinnerHeader(h []string) bool {
	has1, has2 := false, false
	for _, c := range h {
		if c == "" {
			continue
		}
		if _, ok := matchWinnerCaptions[c]; ok {
			if matchWinnerCaptions[c] == "1" {
				has1 = true
			}
			if matchWinnerCaptions[c] == "2" {
				has2 = true
			}
			continue
		}
		if _, ok := doubleChanceCaptions[c]; ok {
			continue
		}
		return false
	}
	return has1 && has2
}
