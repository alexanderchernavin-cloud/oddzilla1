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
		_ = get(PMIDBase+t.Num, MarketTemplate(t, idx.Lang, false))
		if t.IsMatchWinner {
			_ = get(DoubleChancePMIDBase+t.Num, MarketTemplate(t, idx.Lang, true))
		}
	}
	// Second pass so appends above can't invalidate pointers.
	for i := range out {
		byPMID[out[i].PMID] = &out[i]
	}
	for _, fm := range idx.Factors {
		t := fm.Table
		pmid := PMIDBase + t.Num
		if fm.DoubleChance {
			pmid = DoubleChancePMIDBase + t.Num
		}
		d := byPMID[pmid]
		if d == nil {
			continue
		}
		// Match-winner cells are addressed two ways: by the canonical
		// 1/2/3 id on the main event and by their factor id on sub-events
		// (halves, periods). Line markets are addressed by side id. All
		// forms get a label.
		d.Outcomes[itoa(fm.FactorID)] = fm.Label
		tpl := OutcomeTemplate(fm, idx.Lang)
		switch {
		case tpl == "":
			delete(d.Outcomes, itoa(fm.FactorID)) // per-match name wins (team placeholder)
		case fm.WinnerOutcome != "":
			d.Outcomes[fm.WinnerOutcome] = tpl
		case fm.SideID != "":
			if _, done := d.Outcomes[fm.SideID]; !done {
				d.Outcomes[fm.SideID] = tpl
			}
		default:
			d.Outcomes[itoa(fm.FactorID)] = tpl
		}
		if fm.DoubleChance {
			// Sub-event double-chance cells stay in the base pmid market.
			base := byPMID[PMIDBase+t.Num]
			if base != nil {
				base.Outcomes[itoa(fm.FactorID)] = fm.Label
			}
		}
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
	switch strings.TrimSpace(s) {
	case "%1":
		return "home" // renderOutcomeLabel maps the bare word to the team name
	case "%2":
		return "away"
	}
	if strings.Contains(s, "%1") || strings.Contains(s, "%2") {
		// A team placeholder inside a longer caption cannot be rendered by
		// the storefront's template engine; return "" so the API falls back
		// to market_outcomes.name, which the mapper fills per match.
		return ""
	}
	return strings.TrimSpace(s)
}
