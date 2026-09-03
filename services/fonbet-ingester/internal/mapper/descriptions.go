// Market / outcome description templates derived from the Fonbet
// catalogue. Written to market_descriptions / outcome_descriptions so the
// storefront renders real labels instead of "Market #1000304".
//
// Template conventions match what services/api/src/lib/market-naming.ts
// substitutes: `{handicap}` / `{threshold}` for the line, `{side}` for the
// per-team tables (rendered as the team name), and the outcome words
// `home` / `away` / `draw` for match-winner cells (rendered as team names
// / "Draw").

package mapper

import (
	"strings"

	"github.com/oddzilla/fonbet-ingester/internal/fonbet"
)

type Description struct {
	PMID     int
	Variant  string
	Lang     string
	Name     string
	Outcomes map[string]string // outcome id → template
}

// StaticDescriptions builds the base (variant "") templates for every
// catalogue table in the index language.
func StaticDescriptions(idx *fonbet.Index, opt Options) []Description {
	out := make([]Description, 0, len(idx.Tables)*2)
	byPMID := map[int]*Description{}
	get := func(pmid int, name string) *Description {
		d := byPMID[pmid]
		if d == nil {
			out = append(out, Description{PMID: pmid, Lang: idx.Lang, Name: name, Outcomes: map[string]string{}})
			d = &out[len(out)-1]
			byPMID[pmid] = d
		}
		return d
	}
	for _, t := range idx.Tables {
		_ = get(opt.pmidBase()+t.Num, MarketTemplate(t, idx.Lang, false))
		if t.IsMatchWinner {
			_ = get(opt.dcBase()+t.Num, MarketTemplate(t, idx.Lang, true))
		}
	}
	// Second pass so appends above can't invalidate pointers.
	for i := range out {
		byPMID[out[i].PMID] = &out[i]
	}
	for _, fm := range idx.Factors {
		t := fm.Table
		pmid := opt.pmidBase() + t.Num
		if fm.DoubleChance {
			pmid = opt.dcBase() + t.Num
		}
		d := byPMID[pmid]
		if d == nil {
			continue
		}
		id := itoa(fm.FactorID)
		if fm.WinnerOutcome != "" {
			id = fm.WinnerOutcome
		}
		d.Outcomes[id] = OutcomeTemplate(fm, idx.Lang)
	}
	return out
}

// MarketTemplate renders the base template of a table.
func MarketTemplate(t *fonbet.TableMeta, lang string, doubleChance bool) string {
	name := t.Name
	if doubleChance {
		if lang == "ru" {
			name = "Двойной шанс"
		} else {
			name = "Double chance"
		}
	}
	if t.Side != "" {
		name = "{side}: " + name
	}
	if key := t.Param.SpecifierKey(); key != "" && !strings.Contains(name, "{"+key+"}") {
		name = name + " {" + key + "}"
	}
	return strings.TrimSpace(name)
}

// VariantTemplate prefixes the base template with the sub-event label.
func VariantTemplate(label, base string) string {
	return strings.TrimSpace(label) + ": " + base
}

// OutcomeTemplate renders one outcome's template.
func OutcomeTemplate(fm *fonbet.FactorMeta, lang string) string {
	switch fm.WinnerOutcome {
	case "1":
		return "home"
	case "2":
		return "away"
	case "3":
		if lang == "ru" {
			return "Ничья"
		}
		return "draw"
	}
	s := fm.Label
	if key := fm.Table.Param.SpecifierKey(); key != "" {
		s = strings.ReplaceAll(s, "%P", "{"+key+"}")
	}
	s = strings.ReplaceAll(s, "%1", "home")
	s = strings.ReplaceAll(s, "%2", "away")
	return strings.TrimSpace(s)
}
