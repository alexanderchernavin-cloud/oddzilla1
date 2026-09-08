package mapper

import (
	"testing"

	"github.com/oddzilla/fonbet-ingester/internal/fonbet"
)

func TestCategoryKeyFoldsSpellingVariants(t *testing.T) {
	// Every pair measured on the live line 2026-09-07 as the SAME
	// competition filed under two spellings.
	same := [][2]string{
		{"UEFA Champions League", "Champions League UEFA"}, // word order
		{"National teams", "National Teams"},               // case
		{"Short-hockey", "Short Hockey"},                   // hyphen
		{"Formula-1", "Formula 1"},                         // hyphen
	}
	for _, p := range same {
		if categoryKey(p[0]) != categoryKey(p[1]) {
			t.Errorf("%q and %q should share a key, got %q vs %q",
				p[0], p[1], categoryKey(p[0]), categoryKey(p[1]))
		}
	}

	// Distinct competitions that must keep their own buckets. The first
	// four share words with a neighbour and are exactly what a looser
	// rule would swallow.
	distinct := []string{
		"UEFA Champions League",
		"UEFA Europa League",
		"UEFA Conference League",
		"UEFA Youth League",
		"Africa Champions League",
		"England",
		"Spain",
		"Formula-1",
		"Formula-2",
	}
	seen := map[string]string{}
	for _, name := range distinct {
		k := categoryKey(name)
		if prev, ok := seen[k]; ok {
			t.Errorf("%q collided with %q on key %q", name, prev, k)
		}
		seen[k] = name
	}
}

func TestCategoryKeyIgnoresNonAlphanumerics(t *testing.T) {
	if got, want := categoryKey("  Bosnia & Herzegovina  "), "bosnia herzegovina"; got != want {
		t.Errorf("categoryKey = %q, want %q", got, want)
	}
	// Cyrillic survives: the Russian-era rows are still in the catalogue
	// and must keep keys of their own rather than folding to empty.
	if categoryKey("Швеция") == "" {
		t.Error("Cyrillic name keyed to empty")
	}
	if categoryKey("Швеция") == categoryKey("Sweden") {
		t.Error("Cyrillic and Latin names must not merge")
	}
}

// seg builds a segment under root sport `root`.
func seg(root, id int, name string) *fonbet.Sport {
	parent := root
	return &fonbet.Sport{ID: id, Name: name, ParentID: &parent}
}

const (
	football = 1
	hockey   = 2
	cricket  = 3
)

// canon is the test's view of the resolver: what category does a segment
// with this name, under this root, land in? Mirrors categoryOf in Build.
func canon(m map[string]string, root int, segmentName string) string {
	name := categoryFromSegment(segmentName)
	if c, ok := m[categoryGroupKey(root, name)]; ok {
		return c
	}
	return name
}

func TestCanonicalCategoriesPicksLowestSegmentID(t *testing.T) {
	// The real Champions League segment set, ids and names verified
	// against the live line on 2026-09-07. Both spellings carry six
	// segments, so a "most segments wins" rule ties; the lowest id
	// (63304) picks the spelling the operator has pinned.
	sports := map[int]*fonbet.Sport{
		football: {ID: football, Name: "Football"},
		63304:    seg(football, 63304, "UEFA Champions League. Top scorer"),
		113724:   seg(football, 113724, "UEFA Champions League. League phase"),
		131103:   seg(football, 131103, "UEFA Champions League. League phase. Outrights"),
		138562:   seg(football, 138562, "UEFA Champions League. Special Bets"),
		146112:   seg(football, 146112, "UEFA Champions League. Head-to-head in the tournament"),
		146113:   seg(football, 146113, "UEFA Champions League. Which country's team will be the winner"),
		142993:   seg(football, 142993, "Champions League UEFA. Outrights"),
		146084:   seg(football, 146084, "Champions League UEFA. League phase. Best Spanish team"),
		146085:   seg(football, 146085, "Champions League UEFA. League phase. Best English team"),
		146086:   seg(football, 146086, "Champions League UEFA. League phase. Best Germany team"),
		146087:   seg(football, 146087, "Champions League UEFA. League phase. Best Italian team"),
		146114:   seg(football, 146114, "Champions League UEFA. League phase. Head-to-head"),
	}
	m := canonicalCategories(sports)
	// Both spellings resolve to the one bucket — the actual complaint:
	// "League phase. Head-to-head" was filed apart from "League phase".
	for _, name := range []string{
		"UEFA Champions League. League phase",
		"Champions League UEFA. League phase. Head-to-head",
		"UEFA Champions League. Head-to-head in the tournament",
	} {
		if got := canon(m, football, name); got != "UEFA Champions League" {
			t.Errorf("%q -> category %q, want %q", name, got, "UEFA Champions League")
		}
	}
}

func TestCanonicalCategoriesIsOrderIndependent(t *testing.T) {
	// Map iteration is randomised in Go, so the same input must give the
	// same answer across runs or the category slug — the row's identity —
	// would flap and mint new rows.
	sports := map[int]*fonbet.Sport{
		hockey: {ID: hockey, Name: "Hockey"},
		900:    seg(hockey, 900, "Short-hockey. Group A"),
		901:    seg(hockey, 901, "Short Hockey. Group B"),
		902:    seg(hockey, 902, "Short Hockey. Group C"),
		903:    seg(hockey, 903, "Short Hockey. Group D"),
	}
	want := canon(canonicalCategories(sports), hockey, "Short Hockey. Group B")
	if want != "Short-hockey" {
		t.Fatalf("canonical = %q, want %q (lowest id 900)", want, "Short-hockey")
	}
	for i := 0; i < 50; i++ {
		if got := canon(canonicalCategories(sports), hockey, "Short Hockey. Group B"); got != want {
			t.Fatalf("run %d gave %q, want %q", i, got, want)
		}
	}
}

func TestCanonicalCategoriesAreScopedPerRootSport(t *testing.T) {
	// "National teams" is a category under several sports on the live
	// line. A category row is (sport_id, slug), so the spelling is decided
	// per sport: cricket's oldest segment must not rename football's.
	sports := map[int]*fonbet.Sport{
		football: {ID: football, Name: "Football"},
		cricket:  {ID: cricket, Name: "Cricket"},
		100:      seg(cricket, 100, "National Teams. ODI"),
		200:      seg(football, 200, "National teams. Friendlies"),
		201:      seg(football, 201, "National Teams. Qualifiers"),
	}
	m := canonicalCategories(sports)
	if got := canon(m, cricket, "National Teams. ODI"); got != "National Teams" {
		t.Errorf("cricket -> %q, want %q", got, "National Teams")
	}
	// Football's own lowest id (200) spells it lowercase, and cricket's
	// older segment (100) must not override that.
	if got := canon(m, football, "National Teams. Qualifiers"); got != "National teams" {
		t.Errorf("football -> %q, want %q", got, "National teams")
	}
}

func TestCanonicalCategoriesReHomeDroppedSeparator(t *testing.T) {
	// Real segment, live line 2026-09-07: Fonbet dropped the space after
	// the country, so the first ". " split lands after "Cup" and the
	// category came out as "Bolivia.League Cup" — its own flagless bucket
	// directly under "Bolivia" (production 8293 beside 6645).
	sports := map[int]*fonbet.Sport{
		football: {ID: football, Name: "Football"},
		500:      seg(football, 500, "Bolivia. Primera Division. Season 2026"),
		95010:    seg(football, 95010, "Bolivia.League Cup. Group stage"),
		// A period INSIDE a word, with no category to re-home to: stays.
		600: seg(football, 600, "St.Petersburg Open. Qualifying"),
	}
	m := canonicalCategories(sports)
	if got := canon(m, football, "Bolivia.League Cup. Group stage"); got != "Bolivia" {
		t.Errorf("Bolivia.League Cup -> %q, want %q", got, "Bolivia")
	}
	if got := canon(m, football, "St.Petersburg Open. Qualifying"); got != "St.Petersburg Open" {
		t.Errorf("St.Petersburg Open -> %q, want unchanged", got)
	}
	// The head has to be a category of the SAME sport.
	sports[hockey] = &fonbet.Sport{ID: hockey, Name: "Hockey"}
	sports[700] = seg(hockey, 700, "Bolivia.Cup. Final")
	m = canonicalCategories(sports)
	if got := canon(m, hockey, "Bolivia.Cup. Final"); got != "Bolivia.Cup" {
		t.Errorf("hockey Bolivia.Cup -> %q, want unchanged (no Bolivia under hockey)", got)
	}
}

func TestCanonicalCategoriesInnerDotOnlyInFirstSegment(t *testing.T) {
	// The two live look-alikes carry their inner dot in a LATER segment;
	// the category is the first segment and is untouched.
	sports := map[int]*fonbet.Sport{
		hockey: {ID: hockey, Name: "Basketball"},
		800:    seg(hockey, 800, "Cup of Belov-Kondrashin. St.Petersburg"),
		801:    seg(hockey, 801, "Russia. Women. Legends Cup named V.I. Savvin"),
		802:    seg(hockey, 802, "Russia. Superleague"),
	}
	m := canonicalCategories(sports)
	if got := canon(m, hockey, "Cup of Belov-Kondrashin. St.Petersburg"); got != "Cup of Belov-Kondrashin" {
		t.Errorf("-> %q", got)
	}
	if got := canon(m, hockey, "Russia. Women. Legends Cup named V.I. Savvin"); got != "Russia" {
		t.Errorf("-> %q", got)
	}
}

func TestCanonicalCategoriesLeavesSingleSpellingsAlone(t *testing.T) {
	sports := map[int]*fonbet.Sport{
		football: {ID: football, Name: "Football"},
		500:      seg(football, 500, "England. Premier League. Season 26/27"),
		501:      seg(football, 501, "Spain. Primera Division. Season 26/27"),
		502:      seg(football, 502, "Standalone"), // single-segment -> no category
	}
	m := canonicalCategories(sports)
	if got := canon(m, football, "England. Premier League. Season 26/27"); got != "England" {
		t.Errorf("England -> %q", got)
	}
	if _, ok := m[categoryGroupKey(football, CategoryOther)]; ok {
		t.Error("single-segment names must not claim a canonical entry")
	}
}

func TestCategoryAliasesFoldAbbreviationsAndStaleYears(t *testing.T) {
	// The reported case: Fonbet writes both prefixes for one country, and
	// they share no word multiset so categoryKey cannot fold them.
	if got := aliasedCategory("Czech"); got != "Czech Republic" {
		t.Errorf("Czech -> %q, want %q", got, "Czech Republic")
	}
	// Keyed through categoryKey, so case and punctuation variants of an
	// alias fold too without a second entry.
	for _, spelling := range []string{"czech", "CZECH", " Czech "} {
		if got := aliasedCategory(spelling); got != "Czech Republic" {
			t.Errorf("%q -> %q, want %q", spelling, got, "Czech Republic")
		}
	}
	// Stale year suffixes drop the year rather than keeping it.
	if got := aliasedCategory("Tour of Britain 2025"); got != "Tour of Britain" {
		t.Errorf("-> %q", got)
	}
	// Word-order sensitive: categoryKey sorts tokens, so "Mix fights"
	// keys as "fights mix". Hand-written keys got two of these five wrong
	// the first time, which is why the index is derived rather than typed.
	if got := aliasedCategory("Mix fights"); got != "Mix" {
		t.Errorf("-> %q", got)
	}
	if got := aliasedCategory("European Championship 2023"); got != "European Championship" {
		t.Errorf("-> %q", got)
	}
	// Already-canonical names pass through untouched.
	for _, name := range []string{"Czech Republic", "Tour of Britain", "England", "Spain"} {
		if got := aliasedCategory(name); got != name {
			t.Errorf("%q was rewritten to %q", name, got)
		}
	}
}

func TestCategoryAliasesLeaveSimulationsApart(t *testing.T) {
	// NHL 26 is the SIMULATED game, the same shape as FC 26 under Football
	// and NBA 2K26 under Basketball. A word-prefix rule would fold it into
	// the real NHL — which is why this is a list and not a rule. Neither
	// side may move.
	for _, name := range []string{"NHL", "NHL 26", "FC 26", "NBA 2K26"} {
		if got := aliasedCategory(name); got != name {
			t.Errorf("%q was rewritten to %q; simulations must stay apart", name, got)
		}
	}
}

func TestAliasComposesWithTheSpellingFold(t *testing.T) {
	// An alias runs BEFORE canonicalCategories, so a sport carrying both
	// "Czech" and a case variant of the target ends up with one bucket.
	sports := map[int]*fonbet.Sport{
		football: {ID: football, Name: "Football"},
		300:      seg(football, 300, "Czech Republic. League 2"),
		301:      seg(football, 301, "Czech. Cup. Round 3"),
		302:      seg(football, 302, "czech republic. League 3"),
	}
	m := canonicalCategories(sports)
	want := "Czech Republic"
	for _, segment := range []string{
		"Czech Republic. League 2",
		"Czech. Cup. Round 3",
		"czech republic. League 3",
	} {
		name := aliasedCategory(categoryFromSegment(segment))
		got := name
		if c, ok := m[categoryGroupKey(football, name)]; ok {
			got = c
		}
		if got != want {
			t.Errorf("%q -> %q, want %q", segment, got, want)
		}
	}
}
