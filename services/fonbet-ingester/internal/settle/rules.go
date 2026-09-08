// Grading rules: final scores → outcome results for the market shapes the
// mapper produces. Pure functions, unit-tested in rules_test.go and
// rules_en_test.go.
//
// Result encoding is the Oddin wire form services/settlement understands:
// Result "1" won / "0" lost, VoidFactor "" (none) / "1" (void, stake back)
// / "0.5" (half — quarter lines). See settler.mapOutcomeResult.
//
// Scope (deliberately conservative — a wrong settlement is real-money
// loss, an unsettled market only delays payout):
//   - match winner 1/2/3, double chance 1X/12/X2, and the plain two-way
//     "To win the match" table (not flagged main by Fonbet, so it is
//     recognised by shape here rather than by the catalogue flag)
//   - both teams to score, yes / no
//   - handicap h1/h2 and total over/under (whole, half and quarter lines,
//     including team totals via the `side` specifier)
//   - the same on halves / periods / sets (variant markets) and on
//     statistic rows the results feed carries (corners, cards, aces, ...)
//   - fight sports (MMA, boxing): winner from the finishing side, total
//     rounds from the finishing round when that round decides the line
//   - sports with an unambiguous main-time convention (see sportRule)
//
// Everything else is left open for the operator. The grader reads Fonbet's
// text in ENGLISH only — the feed is read from fon.bet with FONBET_LANG=en;
// the Russian vocabulary that existed while the line came from fonbet.kz
// was removed on 2026-09-06.

package settle

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/oddzilla/fonbet-ingester/internal/fonbet"
	"github.com/oddzilla/fonbet-ingester/internal/mapper"
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
	OT    *fonbet.Score           // "extra time" row, when present
	Shoot *fonbet.Score           // "penalty shootouts" row, when present
	Stats map[string]fonbet.Score // statistic rows keyed by lower-cased name ("corners")
	// Section is the results-feed section (competition) name the match was
	// filed under, e.g. "Darts. PDC. European Tour. Czech Republic. 2nd
	// round. 11 legs". It carries the one piece of format information the
	// score itself does not: a darts headline is legs in a legs-format
	// event and sets in a set-play one, and only the section says which.
	Section string
}

// halfKind says what an English "Nth half" label means for a sport: one
// period of a two-part game (football) or two periods of a quarter-based
// one (basketball). halfUnknown refuses to grade the label rather than
// guess; verified against the live line (2026-09-04), only the sports
// marked below emit it at all.
type halfKind int

const (
	halfUnknown      halfKind = iota // refuse: no known convention
	halfIsPeriod                     // football-style: 1st half == period 1
	halfIsTwoPeriods                 // quarter-style: 1st half == periods 1+2
)

// sportRule says how a sport's main-time score relates to its markets.
type sportRule struct {
	// setBased: headline counts sets; handicaps / totals without "set" in
	// the table name are on games / points = sum of the period scores.
	setBased bool
	// otIncluded: two-way markets (no draw) include overtime — add the OT
	// row to the headline (basketball, american football).
	otIncluded bool
	// half is what an English "Nth half" resolves to. Left at halfUnknown
	// for sports that play neither shape (hockey periods, 3x3 basketball).
	half halfKind
	// fight: the results feed scores a bout as "<round>:0" / "0:<round>" —
	// the winner's side carries the round the fight ended in (the scheduled
	// distance when it went to the cards). See gradeFight.
	fight bool
}

// Keys are Fonbet root sport ids (sports.provider_urn = fb:sport:<id>).
var sportRules = map[int]sportRule{
	1:     {half: halfIsPeriod},                       // football — headline is regular time
	1434:  {half: halfIsPeriod},                       // futsal
	8:     {half: halfIsPeriod},                       // handball
	2:     {},                                         // ice hockey — periods, no halves; OT / shootout tables are skipped by name
	11627: {},                                         // floorball — periods
	1219:  {},                                         // water polo
	16:    {half: halfIsPeriod},                       // rugby
	3:     {otIncluded: true, half: halfIsTwoPeriods}, // basketball
	47041: {otIncluded: true},                         // basketball 3x3 — one period, no halves
	6:     {otIncluded: true, half: halfIsTwoPeriods}, // american football
	5:     {otIncluded: true},                         // baseball (extra innings come as OT rows)
	4:     {setBased: true},                           // tennis
	3088:  {setBased: true},                           // table tennis
	9:     {setBased: true},                           // volleyball
	11630: {setBased: true},                           // badminton
	11624: {setBased: true},                           // beach volleyball

	// Added 2026-09-06 as the operator's temporary rules for the sports the
	// grader refused wholesale (3 177 open markets on the 09-05 fixtures).
	// Each is the industry-standard convention for the shapes Fonbet
	// actually quotes on them — match result, double chance, handicap,
	// total, team totals, and the same per quarter / half / period / set.
	// The results feed shapes were read off the 09-04 and 09-05 documents.
	11638: {half: halfIsTwoPeriods}, // australian football — "141:88 (42-16 26-22 41-25 32-25)": four quarters, regular time; "1st half" is quarters 1+2 (bet365 / Pinnacle: extra time excluded unless stated)
	10:    {half: halfIsPeriod},     // bandy — "4:4 (0-2 4-2)": two halves, regular time, football convention
	11625: {},                       // beach soccer — "3:4 (2-1 0-1 1-2)": three periods, headline is regular time; the shootout is its own row and only breaks two-way ties
	17591: {setBased: true},         // padel — "0:2 (3-6 4-6)": sets with games, tennis convention (totals / handicaps are games)
	37145: {fight: true},            // martial arts (MMA) — "2:0" = home won in round 2, "0:3" = away in round 3
	1436:  {fight: true},            // boxing — same encoding; "0:12" is a 12-round decision for the away corner
	11632: {},                       // darts — "2:6" is legs in a legs-format event; Grade refuses set-play sections
}

// unsafeTableWords: table names that settle on something the headline
// score does not carry unambiguously (overtime results, odd / even,
// correct score, penalty counts, playoff-series markets, minute markets).
// Matched as whole words; prefixes cover inflections ("overtime" /
// "overtimes", "penalty" / "penalties", "minute" / "minutes"). Checked
// against the live English catalogue (2026-09-04): these flag every
// gradable-by-shape table that must not be graded off the goal score.
var unsafeTableWords = []string{
	"ot", "odd", "even", "exact", "correct", "shootout", "shootouts", "series",
}
var unsafePrefixWords = []string{
	"overtim", "penalt", "minute",
}

// English puts the period marker at either end of the label — "1st half
// corners" but "Yellow cards — 1st half" — so both ends are tried. The
// unit list is only what the live line emits (2026-09-04); plural
// "innings" is deliberately absent because Fonbet uses it for a cumulative
// "first N innings" row rather than the Nth one.
const enPeriodUnits = `half|period|set|quarter|inning|map`

var (
	periodEnPrefixRe = regexp.MustCompile(`^(\d+)(?:st|nd|rd|th)\s+(` + enPeriodUnits + `)\b`)
	periodEnSuffixRe = regexp.MustCompile(`\s*[—–-]?\s*(\d+)(?:st|nd|rd|th)\s+(` + enPeriodUnits + `)$`)
)

// labelTarget describes which score a sub-event label points at.
type labelTarget struct {
	period int // 1-based period, 0 = whole match
	half   int // 1 or 2 for a quarter-style half (two periods each)
	// ambiguousHalf carries an English "Nth half" until resolveHalf knows
	// the sport — see halfKind.
	ambiguousHalf int
	stat          string // statistic row name, "" = the match score itself
}

func parseLabel(label string) labelTarget {
	l := strings.ToLower(strings.TrimSpace(label))
	var t labelTarget
	matchEnglishPeriod(&t, &l)
	t.stat = strings.TrimSpace(strings.Trim(l, "—–- "))
	return t
}

// matchEnglishPeriod strips an English period marker from either end of
// the label. Whatever is left is a statistic row name, and it has to exist
// in the results feed before it grades anything — that is what keeps
// aggregate specials out of scope: "8 matches 1st half" and "Red card in
// the 1st half" both parse here, then fail the statistic lookup in
// scoreFor and stay open for the operator.
func matchEnglishPeriod(t *labelTarget, l *string) bool {
	var rest string
	m := periodEnPrefixRe.FindStringSubmatch(*l)
	if m != nil {
		rest = (*l)[len(m[0]):]
	} else {
		if m = periodEnSuffixRe.FindStringSubmatch(*l); m == nil {
			return false
		}
		rest = (*l)[:len(*l)-len(m[0])]
	}
	n, _ := strconv.Atoi(m[1])
	if m[2] == "half" {
		t.ambiguousHalf = n
	} else {
		t.period = n
	}
	*l = strings.TrimSpace(rest)
	return true
}

// resolveHalf turns an English "Nth half" into the score target the sport
// actually plays. ok=false when we have no convention for that sport: the
// market then stays open instead of being graded on a guess.
func resolveHalf(t labelTarget, sport int) (labelTarget, bool) {
	if t.ambiguousHalf == 0 {
		return t, true
	}
	n := t.ambiguousHalf
	t.ambiguousHalf = 0
	switch sportRules[sport].half {
	case halfIsPeriod:
		t.period = n
	case halfIsTwoPeriods:
		t.half = n
	default:
		return t, false
	}
	return t, true
}

// scoreFor resolves the (home, away) numbers a market settles on.
// ok=false when the results feed does not carry that score. otApplied
// reports that the overtime row was already folded into the result, so a
// tie-break must not add it a second time.
func scoreFor(ss ScoreSet, t labelTarget, sport int, table *fonbet.TableMeta, twoWay bool) (home, away int, otApplied, ok bool) {
	rule, known := sportRules[sport]
	if !known {
		return 0, 0, false, false
	}
	base := ss.Main
	if t.stat != "" {
		s, found := ss.Stats[t.stat]
		if !found {
			return 0, 0, false, false
		}
		base = s
	}
	if t.half > 0 {
		i, j := (t.half-1)*2, (t.half-1)*2+1
		if j >= len(base.Periods) {
			return 0, 0, false, false
		}
		return base.Periods[i][0] + base.Periods[j][0], base.Periods[i][1] + base.Periods[j][1], false, true
	}
	if t.period > 0 {
		if t.period > len(base.Periods) {
			return 0, 0, false, false
		}
		return base.Periods[t.period-1][0], base.Periods[t.period-1][1], false, true
	}
	// Whole match.
	if t.stat != "" {
		return base.Home, base.Away, false, true
	}
	name := strings.ToLower(table.Name)
	if rule.setBased && !table.IsMatchWinner && !strings.Contains(name, "set") {
		// games / points line: sum of the set scores
		if len(base.Periods) == 0 {
			return 0, 0, false, false
		}
		h, a := 0, 0
		for _, p := range base.Periods {
			h += p[0]
			a += p[1]
		}
		return h, a, false, true
	}
	h, a := base.Home, base.Away
	if rule.otIncluded && twoWay && ss.OT != nil {
		h += ss.OT.Home
		a += ss.OT.Away
		otApplied = true
	}
	return h, a, otApplied, true
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

// dartsSport is Fonbet's darts root id; its headline needs the format guard.
const dartsSport = 11632

// dartsLegsFormat reports whether a darts section name says the event is
// played to legs ("... 2nd round. 11 legs"). Fonbet's line quotes one
// generic Handicap / Total per event and the results headline is in the
// unit of the format — legs on the tour, sets at the World Championship —
// so a headline is only safe to grade when the section says legs.
func dartsLegsFormat(section string) bool {
	return strings.Contains(strings.ToLower(section), "legs")
}

// Market is the slice of a stored market the grader needs.
type Market struct {
	PMID       int
	Specs      map[string]string
	OutcomeIDs []string
}

// Grade returns the graded outcomes for one market, or ok=false with a
// reason when the market is out of scope.
func Grade(mk Market, idx *fonbet.Index, label string, sport int, ss ScoreSet) ([]Outcome, bool, string) {
	if _, isMap := mk.Specs["map"]; isMap {
		return nil, false, "map market"
	}
	tableNum, isDC := mapper.MarketTypeOf(mk.PMID)
	table := idx.Tables[tableNum]
	if table == nil {
		return nil, false, "unknown table"
	}
	if tableUnsafe(table) {
		return nil, false, "table needs manual settlement"
	}
	if sport == dartsSport && !dartsLegsFormat(ss.Section) {
		return nil, false, "darts set-play format"
	}
	target := labelTarget{}
	if label != "" {
		var ok bool
		if target, ok = resolveHalf(parseLabel(label), sport); !ok {
			return nil, false, "ambiguous half label"
		}
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
				if fm := idx.Factors[f]; fm != nil && fm.Label == "X" {
					hasDraw = true
				}
			}
		}
	}
	isWinner := table.IsMatchWinner || twoWayWinner(mk, idx, table)

	// Fight sports score the bout, not a game: the whole-match shapes read
	// the finishing side and round. Statistic rows (knockdowns) and any
	// sub-event fall through to the ordinary arithmetic below.
	if rule := sportRules[sport]; rule.fight && target.stat == "" && target.period == 0 && target.half == 0 {
		return gradeFight(mk, idx, table, isDC, isWinner, hasDraw, ss)
	}

	if yes, no, ok := bothTeamsToScore(mk, idx); ok {
		h, a, _, ok := scoreFor(ss, target, sport, table, false)
		if !ok {
			return nil, false, "no score"
		}
		both := h > 0 && a > 0
		return sortOutcomes([]Outcome{{ID: yes, Result: boolResult(both)}, {ID: no, Result: boolResult(!both)}}), true, ""
	}

	switch {
	case isDC:
		h, a, _, ok := scoreFor(ss, target, sport, table, false)
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
			case "1X":
				won = h >= a
			case "12":
				won = h != a
			case "X2":
				won = a >= h
			default:
				return nil, false, "unknown dc label " + fm.Label
			}
			outs = append(outs, Outcome{ID: id, Result: boolResult(won)})
		}
		return sortOutcomes(outs), true, ""

	case isWinner:
		h, a, otApplied, ok := scoreFor(ss, target, sport, table, !hasDraw)
		if !ok {
			return nil, false, "no score"
		}
		if h == a && !hasDraw {
			h, a, ok = breakTie(h, a, ss, target, otApplied)
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
			var won bool
			switch side {
			case "1":
				won = h > a
			case "2":
				won = a > h
			case "X":
				won = h == a
			case "1X": // double-chance cells stay in the sub-event winner market
				won = h >= a
			case "12":
				won = h != a
			case "X2":
				won = a >= h
			}
			outs = append(outs, Outcome{ID: id, Result: boolResult(won)})
		}
		return sortOutcomes(outs), true, ""

	case table.Param == fonbet.ParamHandicap && ids["h1"] && ids["h2"] && len(ids) == 2:
		line, err := strconv.ParseFloat(mk.Specs["handicap"], 64)
		if err != nil {
			return nil, false, "bad handicap line"
		}
		h, a, _, ok := scoreFor(ss, target, sport, table, true)
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
		h, a, _, ok := scoreFor(ss, target, sport, table, true)
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

// bothTeamsToScore recognises Fonbet's "Both teams to score" table (2800,
// main and per half). The table has no name of its own — its caption is
// only the sub-event prefix — so the shape is read off the two factors,
// whose labels the catalogue renders as "Both teams to score Yes" / "...
// No". Returns the yes and no outcome ids.
func bothTeamsToScore(mk Market, idx *fonbet.Index) (yes, no string, ok bool) {
	if len(mk.OutcomeIDs) != 2 {
		return "", "", false
	}
	for _, id := range mk.OutcomeIDs {
		f, err := strconv.Atoi(id)
		if err != nil {
			return "", "", false
		}
		fm := idx.Factors[f]
		if fm == nil {
			return "", "", false
		}
		l := strings.ToLower(strings.TrimSpace(fm.Label))
		if !strings.Contains(l, "both teams to score") {
			return "", "", false
		}
		switch {
		case strings.HasSuffix(l, " yes"):
			yes = id
		case strings.HasSuffix(l, " no"):
			no = id
		default:
			return "", "", false
		}
	}
	return yes, no, yes != "" && no != ""
}

// twoWayWinner recognises a plain 1 / 2 winner table that Fonbet does not
// flag as main — "To win the match" (491) and its overtime variants. The
// catalogue's IsMatchWinner requires isMain because that flag also drives
// the storefront's 1/2/3 outcome ids, so it cannot be widened without
// changing market identity; the grader reads the shape instead: one row,
// no line, exactly two outcomes whose factor labels are "1" and "2".
func twoWayWinner(mk Market, idx *fonbet.Index, table *fonbet.TableMeta) bool {
	if table.IsMatchWinner || table.Param != fonbet.ParamNone || len(table.Rows) != 1 || len(mk.OutcomeIDs) != 2 {
		return false
	}
	seen := map[string]bool{}
	for _, id := range mk.OutcomeIDs {
		side := winnerSide(id, idx)
		if side != "1" && side != "2" {
			return false
		}
		seen[side] = true
	}
	return seen["1"] && seen["2"]
}

// gradeFight settles the whole-bout shapes of MMA and boxing off Fonbet's
// "<round>:0" / "0:<round>" headline: the winner is the non-zero side and
// the number is the round the fight ended in (the scheduled distance for a
// decision). Standard rules (bet365 / Pinnacle fight markets):
//
//   - winner / double chance: the finishing side; a bout with no winner
//     recorded (draw, no contest, "0:0") is refused — the feed does not
//     say which, and only one of them is a void
//   - total rounds: "over N.5" means the fight passed the half-way mark of
//     round N+1, so a finish in round N+2 or later is over and a finish in
//     round N or earlier is under; a finish IN round N+1 needs the clock,
//     which the feed does not carry, and is refused. A whole-number line
//     is read the same way (a finish in round N is under, a finish in
//     round N+1 or later is over, the distance being exactly N is a push
//     the feed cannot distinguish from a finish in round N — refused)
//   - handicaps (rounds or points) are refused: the feed has no scorecards
func gradeFight(mk Market, idx *fonbet.Index, table *fonbet.TableMeta, isDC, isWinner, hasDraw bool, ss ScoreSet) ([]Outcome, bool, string) {
	h, a := ss.Main.Home, ss.Main.Away
	switch {
	case isDC || isWinner:
		if h == a {
			return nil, false, "fight result undecided"
		}
		homeWon := h > a
		var outs []Outcome
		for _, id := range mk.OutcomeIDs {
			side := winnerSide(id, idx)
			if side == "" {
				return nil, false, "unknown winner outcome " + id
			}
			var won bool
			switch side {
			case "1", "1X":
				won = homeWon
			case "2", "X2":
				won = !homeWon
			case "12":
				won = true
			case "X":
				won = false
			}
			outs = append(outs, Outcome{ID: id, Result: boolResult(won)})
		}
		return sortOutcomes(outs), true, ""

	case table.Param == fonbet.ParamThreshold && len(mk.OutcomeIDs) == 2 && mk.Specs["side"] == "":
		line, err := strconv.ParseFloat(mk.Specs["threshold"], 64)
		if err != nil {
			return nil, false, "bad total line"
		}
		if h == a {
			return nil, false, "fight result undecided"
		}
		round := h
		if a > h {
			round = a
		}
		deciding := int(math.Ceil(line))
		var over, under graded
		switch {
		case round > deciding:
			over, under = gWon, gLost
		case round < deciding:
			over, under = gLost, gWon
		default:
			return nil, false, "fight ended in the deciding round"
		}
		var outs []Outcome
		for _, id := range mk.OutcomeIDs {
			switch id {
			case "over":
				outs = append(outs, Outcome{ID: id, Result: over.res, VoidFactor: over.vf})
			case "under":
				outs = append(outs, Outcome{ID: id, Result: under.res, VoidFactor: under.vf})
			default:
				return nil, false, "unsupported market shape"
			}
		}
		return sortOutcomes(outs), true, ""

	case table.Param == fonbet.ParamHandicap:
		return nil, false, "fight handicap"
	}
	return nil, false, "unsupported market shape"
}

// breakTie resolves a two-way market tied after main time using the OT
// and shootout rows when the feed has them. otApplied says scoreFor
// already folded the OT row in (otIncluded sports): adding it again would
// double-count it and could invent a winner for a game that was still
// level after the recorded overtime — the shootout row is the only thing
// left to consult then.
func breakTie(h, a int, ss ScoreSet, t labelTarget, otApplied bool) (int, int, bool) {
	if t.stat != "" || t.period > 0 || t.half > 0 {
		return h, a, false
	}
	if ss.OT != nil && !otApplied {
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
			case "1", "2", "12", "X", "1X", "X2":
				return fm.Label
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
	sort.Slice(outs, func(i, j int) bool { return outs[i].ID < outs[j].ID })
	return outs
}
