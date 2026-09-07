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

func seg(id int, name string) *fonbet.Sport {
	parent := 1
	return &fonbet.Sport{ID: id, Name: name, ParentID: &parent}
}

func TestCanonicalCategoriesPicksLowestSegmentID(t *testing.T) {
	// The real Champions League segment set, ids and names verified
	// against the live line on 2026-09-07. Both spellings carry six
	// segments, so a "most segments wins" rule ties; the lowest id
	// (63304) picks the spelling the operator has pinned.
	sports := map[int]*fonbet.Sport{
		1:      {ID: 1, Name: "Football"},
		63304:  seg(63304, "UEFA Champions League. Top scorer"),
		113724: seg(113724, "UEFA Champions League. League phase"),
		131103: seg(131103, "UEFA Champions League. League phase. Outrights"),
		138562: seg(138562, "UEFA Champions League. Special Bets"),
		146112: seg(146112, "UEFA Champions League. Head-to-head in the tournament"),
		146113: seg(146113, "UEFA Champions League. Which country's team will be the winner"),
		142993: seg(142993, "Champions League UEFA. Outrights"),
		146084: seg(146084, "Champions League UEFA. League phase. Best Spanish team"),
		146085: seg(146085, "Champions League UEFA. League phase. Best English team"),
		146086: seg(146086, "Champions League UEFA. League phase. Best Germany team"),
		146087: seg(146087, "Champions League UEFA. League phase. Best Italian team"),
		146114: seg(146114, "Champions League UEFA. League phase. Head-to-head"),
	}
	canon := canonicalCategories(sports)
	k := categoryKey("Champions League UEFA")
	if got, want := canon[k], "UEFA Champions League"; got != want {
		t.Fatalf("canonical name = %q, want %q", got, want)
	}

	// Both spellings resolve to the one bucket — the actual complaint:
	// "League phase. Head-to-head" was filed apart from "League phase".
	for _, name := range []string{
		"UEFA Champions League. League phase",
		"Champions League UEFA. League phase. Head-to-head",
		"UEFA Champions League. Head-to-head in the tournament",
	} {
		if got := canon[categoryKey(categoryFromSegment(name))]; got != "UEFA Champions League" {
			t.Errorf("%q -> category %q, want %q", name, got, "UEFA Champions League")
		}
	}
}

func TestCanonicalCategoriesIsOrderIndependent(t *testing.T) {
	// Map iteration is randomised in Go, so the same input must give the
	// same answer across runs or the category slug — the row's identity —
	// would flap and mint new rows.
	sports := map[int]*fonbet.Sport{
		1:   {ID: 1, Name: "Hockey"},
		900: seg(900, "Short-hockey. Group A"),
		901: seg(901, "Short Hockey. Group B"),
		902: seg(902, "Short Hockey. Group C"),
		903: seg(903, "Short Hockey. Group D"),
	}
	want := canonicalCategories(sports)[categoryKey("Short Hockey")]
	if want != "Short-hockey" {
		t.Fatalf("canonical = %q, want %q (lowest id 900)", want, "Short-hockey")
	}
	for i := 0; i < 50; i++ {
		if got := canonicalCategories(sports)[categoryKey("Short Hockey")]; got != want {
			t.Fatalf("run %d gave %q, want %q", i, got, want)
		}
	}
}

func TestCanonicalCategoriesLeavesSingleSpellingsAlone(t *testing.T) {
	sports := map[int]*fonbet.Sport{
		1:   {ID: 1, Name: "Football"},
		500: seg(500, "England. Premier League. Season 26/27"),
		501: seg(501, "Spain. Primera Division. Season 26/27"),
		502: seg(502, "Standalone"), // single-segment -> no category
	}
	canon := canonicalCategories(sports)
	if got := canon[categoryKey("England")]; got != "England" {
		t.Errorf("England -> %q", got)
	}
	if _, ok := canon[categoryKey(CategoryOther)]; ok {
		t.Error("single-segment names must not claim a canonical entry")
	}
}
