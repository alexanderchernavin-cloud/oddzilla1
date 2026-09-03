// Grading rules: final scores → outcome results for the market shapes the
// mapper produces. Pure functions, unit-tested in rules_test.go.
//
// Result encoding is the Oddin wire form services/settlement understands:
// Result "1" won / "0" lost, VoidFactor "" (none) / "1" (void, stake back)
// / "0.5" (half — quarter lines). See settler.mapOutcomeResult.
//
// Scope (deliberately conservative — a wrong settlement is real-money
// loss, an unsettled market only delays payout):
//   - match winner 1/2/3, double chance 1X/12/X2
//   - handicap h1/h2 and total over/under (whole, half and quarter lines,
//     including team totals via the `side` specifier)
//   - the same on halves / periods / sets (variant markets) and on
//     statistic rows the results feed carries (corners, cards, aces, ...)
//   - sports with an unambiguous main-time convention (see sportRule)
// Everything else is left open for manual settlement.

package settle

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/oddzilla/fonbet-ingester/internal/fonbet"
)

// Outcome is one graded selection.
type Outcome struct {
	ID         string `json:"id"`
	Result     string `json:"result"`
	VoidFactor string `json:"void_factor"`
}

// ScoreSet is everything we know about one finished match.
type ScoreSet struct {
	Main  fonbet.Score            // headline score (main time) + period breakdown
	OT    *fonbet.Score           // "дополнительное время" row, when present
	Shoot *fonbet.Score           // "серия пенальти" / "серия буллитов" row, when present
	Stats map[string]fonbet.Score // statistic rows keyed by lower-cased name ("угловые")
}

// sportRule says how a sport's main-time score relates to its markets.
type sportRule struct {
	// setBased: headline counts sets; handicaps / totals without "сет" in
	// the table name are on games / points = sum of the period scores.
	setBased bool
	// otIncluded: two-way markets (no draw) include overtime — add the OT
	// row to the headline (basketball, american football).
	otIncluded bool
}

var sportRules = map[int]sportRule{
	1:     {},                 // football — headline is regular time
	1434:  {},                 // futsal
	8:     {},                 // handball
	2:     {},                 // ice hockey — OT / shootout tables are skipped by name
	11627: {},                 // floorball
	1219:  {},                 // water polo
	16:    {},                 // rugby
	3:     {otIncluded: true}, // basketball
	47041: {otIncluded: true}, // basketball 3x3
	6:     {otIncluded: true}, // american football
	5:     {otIncluded: true}, // baseball (extra innings come as OT rows)
	4:     {setBased: true},   // tennis
	3088:  {setBased: true},   // table tennis
	9:     {setBased: true},   // volleyball
	11630: {setBased: true},   // badminton
	11624: {setBased: true},   // beach volleyball
}

// unsafeTableWords: table names that settle on something the headline
// score does not carry unambiguously.
// Matched as whole words (Cyrillic-aware tokenisation) so "тотал" does
// not trip on "от"; prefixes cover inflections ("дополнительное",
// "точный", "буллитов").
var unsafeTableWords = []string{"от", "пенальти", "доп", "чет", "нечет", "серия"}
var unsafePrefixWords = []string{"дополнит", "точн", "минут", "буллит", "овертайм"}

var periodRe = regexp.MustCompile(`^(\d+)-(?:ый|ой|ая|й|я|е)\s+(тайм|период|сет|четверть|половина|иннинг|партия|карта)(?:\s+|$)`)

// labelTarget describes which score a sub-event label points at.
type labelTarget struct {
	period int    // 1-based period, 0 = whole match
	half   int    // 1 or 2 when the label says "половина" (two periods each)
	stat   string // statistic row name, "" = the match score itself
	set    bool   // the period is a set
}

func parseLabel(label string) labelTarget {
	l := strings.ToLower(strings.TrimSpace(label))
	var t labelTarget
	if m := periodRe.FindStringSubmatch(l); m != nil {
		n, _ := strconv.Atoi(m[1])
		switch m[2] {
		case "половина":
			t.half = n
		case "сет", "партия":
			t.period, t.set = n, true
		default:
			t.period = n
		}
		l = strings.TrimSpace(l[len(m[0]):])
	}
	t.stat = l
	return t
}

// scoreFor resolves the (home, away) numbers a market settles on.
// ok=false when the results feed does not carry that score.
func scoreFor(ss ScoreSet, t labelTarget, sport int, table *fonbet.TableMeta, twoWay bool) (home, away int, ok bool) {
	rule, known := sportRules[sport]
	if !known {
		return 0, 0, false
	}
	base := ss.Main
	if t.stat != "" {
		s, found := ss.Stats[t.stat]
		if !found {
			return 0, 0, false
		}
		base = s
	}
	if t.half > 0 {
		i, j := (t.half-1)*2, (t.half-1)*2+1
		if j >= len(base.Periods) {
			return 0, 0, false
		}
		return base.Periods[i][0] + base.Periods[j][0], base.Periods[i][1] + base.Periods[j][1], true
	}
	if t.period > 0 {
		if t.period > len(base.Periods) {
			return 0, 0, false
		}
		return base.Periods[t.period-1][0], base.Periods[t.period-1][1], true
	}
	// Whole match.
	if t.stat != "" {
		return base.Home, base.Away, true
	}
	name := strings.ToLower(table.Name)
	if rule.setBased && !table.IsMatchWinner && !strings.Contains(name, "сет") && !strings.Contains(name, "set") {
		// games / points line: sum of the set scores
		if len(base.Periods) == 0 {
			return 0, 0, false
		}
		h, a := 0, 0
		for _, p := range base.Periods {
			h += p[0]
			a += p[1]
		}
		return h, a, true
	}
	h, a := base.Home, base.Away
	if rule.otIncluded && twoWay && ss.OT != nil {
		h += ss.OT.Home
		a += ss.OT.Away
	}
	return h, a, true
}

func tableUnsafe(table *fonbet.TableMeta) bool {
	words := strings.FieldsFunc(strings.ToLower(table.Name), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	for _, w := range words {
		for _, u := range unsafeTableWords {
			if w == u {
				return true
			}
		}
		for _, pfx := range unsafePrefixWords {
			if strings.HasPrefix(w, pfx) {
				return true
			}
		}
	}
	return false
}

// Market is the slice of a stored market the grader needs.
type Market struct {
	PMID       int
	Specs      map[string]string
	OutcomeIDs []string
}

// Grade returns the graded outcomes for one market, or ok=false with a
// reason when the market is out of scope.
func Grade(mk Market, idx *fonbet.Index, pmidBase, dcBase int, label string, sport int, ss ScoreSet) ([]Outcome, bool, string) {
	if _, isMap := mk.Specs["map"]; isMap {
		return nil, false, "map market"
	}
	isDC := mk.PMID >= dcBase
	tableNum := mk.PMID - pmidBase
	if isDC {
		tableNum = mk.PMID - dcBase
	}
	table := idx.Tables[tableNum]
	if table == nil {
		return nil, false, "unknown table"
	}
	if tableUnsafe(table) {
		return nil, false, "table needs manual settlement"
	}
	target := labelTarget{}
	if label != "" {
		target = parseLabel(label)
	}
	ids := map[string]bool{}
	for _, id := range mk.OutcomeIDs {
		ids[id] = true
	}
	hasDraw := ids["3"]
	if !hasDraw {
		// sub-event winner markets carry factor ids; look for an X label
		for _, id := range mk.OutcomeIDs {
			if f, err := strconv.Atoi(id); err == nil {
				if fm := idx.Factors[f]; fm != nil && (fm.Label == "X" || fm.Label == "Х") {
					hasDraw = true
				}
			}
		}
	}

	switch {
	case isDC:
		h, a, ok := scoreFor(ss, target, sport, table, false)
		if !ok {
			return nil, false, "no score"
		}
		var outs []Outcome
		for _, id := range mk.OutcomeIDs {
			f, err := strconv.Atoi(id)
			if err != nil {
				return nil, false, "unexpected dc outcome id"
			}
			fm := idx.Factors[f]
			if fm == nil {
				return nil, false, "unknown dc factor"
			}
			var won bool
			switch fm.Label {
			case "1X", "1Х":
				won = h >= a
			case "12":
				won = h != a
			case "X2", "Х2":
				won = a >= h
			default:
				return nil, false, "unknown dc label " + fm.Label
			}
			outs = append(outs, Outcome{ID: id, Result: boolResult(won)})
		}
		return sortOutcomes(outs), true, ""

	case table.IsMatchWinner:
		h, a, ok := scoreFor(ss, target, sport, table, !hasDraw)
		if !ok {
			return nil, false, "no score"
		}
		if h == a && !hasDraw {
			h, a, ok = breakTie(h, a, ss, target)
			if !ok {
				return nil, false, "two-way market tied in main time"
			}
		}
		var outs []Outcome
		for _, id := range mk.OutcomeIDs {
			side := winnerSide(id, idx)
			if side == "" {
				return nil, false, "unknown winner outcome " + id
			}
			won := (side == "1" && h > a) || (side == "2" && a > h) || (side == "X" && h == a)
			outs = append(outs, Outcome{ID: id, Result: boolResult(won)})
		}
		return sortOutcomes(outs), true, ""

	case table.Param == fonbet.ParamHandicap && ids["h1"] && ids["h2"] && len(ids) == 2:
		line, err := strconv.ParseFloat(mk.Specs["handicap"], 64)
		if err != nil {
			return nil, false, "bad handicap line"
		}
		h, a, ok := scoreFor(ss, target, sport, table, true)
		if !ok {
			return nil, false, "no score"
		}
		r1, r2 := gradeHandicap(h, a, line)
		return []Outcome{{ID: "h1", Result: r1.res, VoidFactor: r1.vf}, {ID: "h2", Result: r2.res, VoidFactor: r2.vf}}, true, ""

	case table.Param == fonbet.ParamThreshold && ids["over"] && ids["under"] && len(ids) == 2:
		line, err := strconv.ParseFloat(mk.Specs["threshold"], 64)
		if err != nil {
			return nil, false, "bad total line"
		}
		h, a, ok := scoreFor(ss, target, sport, table, true)
		if !ok {
			return nil, false, "no score"
		}
		total := h + a
		switch mk.Specs["side"] {
		case "home":
			total = h
		case "away":
			total = a
		}
		over, under := gradeTotal(total, line)
		return []Outcome{{ID: "over", Result: over.res, VoidFactor: over.vf}, {ID: "under", Result: under.res, VoidFactor: under.vf}}, true, ""
	}
	return nil, false, "unsupported market shape"
}

// breakTie resolves a two-way market tied after main time using the OT
// and shootout rows when the feed has them.
func breakTie(h, a int, ss ScoreSet, t labelTarget) (int, int, bool) {
	if t.stat != "" || t.period > 0 || t.half > 0 {
		return h, a, false
	}
	if ss.OT != nil {
		h += ss.OT.Home
		a += ss.OT.Away
	}
	if h == a && ss.Shoot != nil {
		h += ss.Shoot.Home
		a += ss.Shoot.Away
	}
	return h, a, h != a
}

func winnerSide(id string, idx *fonbet.Index) string {
	switch id {
	case "1", "2":
		return id
	case "3":
		return "X"
	}
	if f, err := strconv.Atoi(id); err == nil {
		if fm := idx.Factors[f]; fm != nil {
			switch fm.Label {
			case "1", "2":
				return fm.Label
			case "X", "Х":
				return "X"
			}
		}
	}
	return ""
}

type graded struct{ res, vf string }

var (
	gWon      = graded{"1", ""}
	gLost     = graded{"0", ""}
	gVoid     = graded{"1", "1"}
	gHalfWon  = graded{"1", "0.5"}
	gHalfLost = graded{"0", "0.5"}
)

// gradeHandicap grades home (h1) and away (h2) against a home-applied
// line, splitting quarter lines into two half-stakes.
func gradeHandicap(h, a int, line float64) (graded, graded) {
	if isQuarter(line) {
		x1, _ := gradeHandicap(h, a, line-0.25)
		x2, _ := gradeHandicap(h, a, line+0.25)
		r1 := combine(x1, x2)
		return r1, mirror(r1)
	}
	diff := float64(h) + line - float64(a)
	switch {
	case diff > 0:
		return gWon, gLost
	case diff < 0:
		return gLost, gWon
	default:
		return gVoid, gVoid
	}
}

// gradeTotal grades over / under against a line.
func gradeTotal(total int, line float64) (graded, graded) {
	if isQuarter(line) {
		o1, _ := gradeTotal(total, line-0.25)
		o2, _ := gradeTotal(total, line+0.25)
		over := combine(o1, o2)
		return over, mirror(over)
	}
	switch {
	case float64(total) > line:
		return gWon, gLost
	case float64(total) < line:
		return gLost, gWon
	default:
		return gVoid, gVoid
	}
}

func isQuarter(line float64) bool {
	frac := math.Abs(line - math.Trunc(line))
	return math.Abs(frac-0.25) < 1e-9 || math.Abs(frac-0.75) < 1e-9
}

// combine merges the two half-stakes of a quarter line.
func combine(x, y graded) graded {
	switch {
	case x == gWon && y == gWon:
		return gWon
	case x == gLost && y == gLost:
		return gLost
	case (x == gWon && y == gVoid) || (x == gVoid && y == gWon):
		return gHalfWon
	case (x == gLost && y == gVoid) || (x == gVoid && y == gLost):
		return gHalfLost
	}
	return gVoid
}

// mirror is the opposite side's result.
func mirror(g graded) graded {
	switch g {
	case gWon:
		return gLost
	case gLost:
		return gWon
	case gHalfWon:
		return gHalfLost
	case gHalfLost:
		return gHalfWon
	}
	return gVoid
}

func boolResult(won bool) string {
	if won {
		return "1"
	}
	return "0"
}

func sortOutcomes(outs []Outcome) []Outcome {
	for i := 1; i < len(outs); i++ {
		for j := i; j > 0 && outs[j].ID < outs[j-1].ID; j-- {
			outs[j], outs[j-1] = outs[j-1], outs[j]
		}
	}
	return outs
}
