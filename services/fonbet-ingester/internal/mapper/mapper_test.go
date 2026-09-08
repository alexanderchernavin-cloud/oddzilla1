package mapper

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/oddzilla/fonbet-ingester/internal/fonbet"
)

func loadFixtures(t *testing.T) (*fonbet.ListResponse, *fonbet.Index) {
	t.Helper()
	raw, err := os.ReadFile("testdata/list_small.json")
	if err != nil {
		t.Fatalf("read list fixture: %v", err)
	}
	var resp fonbet.ListResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("decode list fixture: %v", err)
	}
	raw, err = os.ReadFile("testdata/catalog_small.json")
	if err != nil {
		t.Fatalf("read catalog fixture: %v", err)
	}
	var cat fonbet.Catalog
	if err := json.Unmarshal(raw, &cat); err != nil {
		t.Fatalf("decode catalog fixture: %v", err)
	}
	return &resp, fonbet.BuildIndex(&cat)
}

func TestBuildFootballMatch(t *testing.T) {
	resp, idx := loadFixtures(t)
	snap := Build(resp, idx, Options{IncludeSubEvents: true, BlockedSports: map[int]struct{}{EsportsRootID: {}}})

	m := findMatch(snap, 67372824)
	if m == nil {
		t.Fatalf("Dinamo - Akhmat (67372824) missing; skipped=%v", snap.Skipped)
	}
	if m.Sport.Slug != "football" || m.SportID != 1 {
		t.Fatalf("sport: got %+v", m.Sport)
	}
	if m.Team1 != "Динамо Москва" || m.Team2 != "Ахмат" {
		t.Fatalf("teams: %q / %q", m.Team1, m.Team2)
	}
	if m.Category == "" || m.Category == "Other" {
		t.Fatalf("category not derived from %q: %q", m.SegmentName, m.Category)
	}

	// Match winner: pmid base + table 120, outcome ids 1 / 3 / 2.
	mw := m.Markets["1000120|"]
	if mw == nil {
		t.Fatalf("match-winner market missing; keys=%v", keys(m.Markets))
	}
	for _, id := range []string{"1", "2", "3"} {
		o := mw.Outcomes[id]
		if o == nil || o.Odds == "" {
			t.Fatalf("match-winner outcome %s missing: %+v", id, mw.Outcomes)
		}
	}
	if mw.Outcomes["1"].Odds != "1.87" || mw.Outcomes["3"].Odds != "3.75" || mw.Outcomes["2"].Odds != "4.3" {
		t.Fatalf("match-winner odds: %+v", mw.Outcomes)
	}
	if len(mw.Outcomes) != 3 {
		t.Fatalf("double chance leaked into match winner: %v", keys2(mw.Outcomes))
	}
	dc := m.Markets["1900120|"]
	if dc == nil || len(dc.Outcomes) != 3 || !dc.DoubleChance {
		t.Fatalf("double chance market: %+v", dc)
	}

	// Handicap: one market per line, two sides, specifier `handicap`.
	hcp := m.Markets["1000304|handicap=-2.5"]
	if hcp == nil {
		t.Fatalf("handicap -2.5 missing; keys=%v", keys(m.Markets))
	}
	if len(hcp.Outcomes) != 2 || hcp.Outcomes["h1"] == nil || hcp.Outcomes["h2"] == nil {
		t.Fatalf("handicap outcomes: %v", keys2(hcp.Outcomes))
	}
	if hcp.Outcomes["h1"].FactorID != 910 || hcp.Outcomes["h2"].FactorID != 912 {
		t.Fatalf("handicap factor ids: %+v", hcp.Outcomes)
	}
	if hcp.Outcomes["h1"].Odds != "6.8" || hcp.Outcomes["h2"].Odds != "1.1" {
		t.Fatalf("handicap odds: %+v", hcp.Outcomes)
	}
	// Totals: `threshold`, over + under on the same line.
	var totals int
	for _, mk := range m.Markets {
		if mk.PMID == 1000305 {
			if mk.Specs["threshold"] == "" || len(mk.Outcomes) != 2 || mk.Outcomes["over"] == nil || mk.Outcomes["under"] == nil {
				t.Fatalf("total market malformed: %+v", mk)
			}
			totals++
		}
	}
	if totals < 3 {
		t.Fatalf("expected several total lines, got %d", totals)
	}
	// Sub-events land as variants with a label.
	var variants, players int
	for _, mk := range m.Markets {
		if mk.Variant != "" {
			variants++
			if mk.VariantLabel == "" {
				t.Fatalf("variant without label: %+v", mk)
			}
			if mk.Specs["variant"] != mk.Variant {
				t.Fatalf("variant spec mismatch: %+v", mk)
			}
		}
		if mk.Variant == "fb:100201" {
			players++ // "1-й тайм"
		}
	}
	if variants == 0 || players == 0 {
		t.Fatalf("sub-event markets missing (variants=%d, firstHalf=%d)", variants, players)
	}
	for _, mk := range m.Markets {
		if len(mk.Hash) != 32 {
			t.Fatalf("hash length: %d", len(mk.Hash))
		}
	}
}

func TestBuildSkipsBlockedSportAndKeepsLive(t *testing.T) {
	resp, idx := loadFixtures(t)
	snap := Build(resp, idx, Options{IncludeSubEvents: true, BlockedSports: map[int]struct{}{EsportsRootID: {}}})
	for _, m := range snap.Matches {
		if m.SportID == EsportsRootID {
			t.Fatalf("esports match leaked through blocklist: %d", m.EventID)
		}
	}
	if snap.Skipped["blocked_sport"] == 0 {
		t.Fatalf("expected the esports fixture match to be counted as blocked: %v", snap.Skipped)
	}
	var live *Match
	for _, m := range snap.Matches {
		if m.Live {
			live = m
			break
		}
	}
	if live == nil {
		t.Fatalf("no live match in fixture")
	}
	if snap.Matches[0] != live {
		t.Fatalf("live match must sort first")
	}
	if live.Score == nil || live.Score.Home == nil {
		t.Fatalf("live score missing: %+v", live.Score)
	}

	// Without the blocklist the esports match is present and its maps are
	// `map=N` specifiers instead of variants.
	snap = Build(resp, idx, Options{IncludeSubEvents: true})
	var cyber *Match
	for _, m := range snap.Matches {
		if m.SportID == EsportsRootID {
			cyber = m
		}
	}
	if cyber == nil {
		t.Fatalf("esports match missing without blocklist")
	}
	if cyber.Sport.Kind != "esport" {
		t.Fatalf("esports kind: %q", cyber.Sport.Kind)
	}
	maps := 0
	for _, mk := range cyber.Markets {
		if mk.Specs["map"] != "" {
			maps++
			if mk.Variant != "" {
				t.Fatalf("map market must not carry a variant: %+v", mk)
			}
		}
	}
	if maps == 0 {
		t.Fatalf("expected map=N markets for the esports match; keys=%v", keys(cyber.Markets))
	}
}

func TestSubEventsCanBeDisabled(t *testing.T) {
	resp, idx := loadFixtures(t)
	snap := Build(resp, idx, Options{IncludeSubEvents: false})
	for _, m := range snap.Matches {
		for _, mk := range m.Markets {
			if mk.Variant != "" || mk.Specs["map"] != "" {
				t.Fatalf("sub-event market present with IncludeSubEvents=false: %+v", mk)
			}
		}
	}
}

func TestNormalizeParamAndOdds(t *testing.T) {
	p := -250
	cases := []struct {
		f    fonbet.Factor
		want string
	}{
		{fonbet.Factor{PT: "+2.5"}, "2.5"},
		{fonbet.Factor{PT: "-2.5"}, "-2.5"},
		{fonbet.Factor{PT: "-0"}, "0"},
		{fonbet.Factor{P: &p}, "-2.5"},
		{fonbet.Factor{PT: "3 - очко 5"}, "3 - очко 5"},
		{fonbet.Factor{PT: "a|b=c"}, "a/b:c"},
	}
	for _, c := range cases {
		if got := NormalizeParam(c.f); got != c.want {
			t.Errorf("NormalizeParam(%+v) = %q, want %q", c.f, got, c.want)
		}
	}
	if FormatOdds(1.8700001) != "1.87" || FormatOdds(10.5) != "10.5" || FormatOdds(1.12345) != "1.1235" {
		t.Errorf("FormatOdds: %s %s %s", FormatOdds(1.8700001), FormatOdds(10.5), FormatOdds(1.12345))
	}
}

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Испания. Примера дивизион": "ispaniya-primera-divizion",
		"Динамо Москва":             "dinamo-moskva",
		"Counter-Strike. IEM Пекин": "counter-strike-iem-pekin",
		"  Real  Madrid CF!! ":      "real-madrid-cf",
		"Bayern München":            "bayern-munchen",
	}
	for in, want := range cases {
		if got := Slugify(in, 0); got != want {
			t.Errorf("Slugify(%q) = %q, want %q", in, got, want)
		}
	}
	if got := Slugify("abcdefghij", 5); got != "abcde" {
		t.Errorf("truncate: %q", got)
	}
}

func TestDescriptions(t *testing.T) {
	_, idx := loadFixtures(t)
	descs := StaticDescriptions(idx, Options{})
	byPMID := map[int]Description{}
	for _, d := range descs {
		byPMID[d.PMID] = d
	}
	mw := byPMID[1000120]
	if mw.Name != "Исходы" || mw.Outcomes["1"] != "home" || mw.Outcomes["2"] != "away" || mw.Outcomes["3"] != "Ничья" {
		t.Fatalf("match-winner description: %+v", mw)
	}
	// The factor ids are how a SUB-EVENT market addresses the same cells
	// (a main-event market carries the canonical 1/2/3 above), so they
	// have to resolve to the same side word or "1st half: Match result"
	// reads "1 / X / 2" where the match tab reads the team names.
	if mw.Outcomes["921"] != "home" || mw.Outcomes["923"] != "away" || mw.Outcomes["922"] != "Ничья" {
		t.Fatalf("match-winner factor ids: %+v", mw.Outcomes)
	}
	// Double-chance cells keep their caption: "1X" is what they mean and
	// no single team names them.
	if mw.Outcomes["924"] != "1X" || mw.Outcomes["925"] != "X2" || mw.Outcomes["1571"] != "12" {
		t.Fatalf("double-chance captions on the base market: %+v", mw.Outcomes)
	}
	dc := byPMID[1900120]
	if dc.Name != "Двойной шанс" || len(dc.Outcomes) != 3 {
		t.Fatalf("double-chance description: %+v", dc)
	}
	// A line table captions its team columns "1" / "2"; the side ids the
	// storefront actually renders carry the side word so every locale
	// shows the team. The factor-id entry is unused for line markets
	// (they are addressed by side id) and keeps the raw caption.
	if h := byPMID[1000304]; h.Name != "Фора {handicap}" || h.Outcomes["h1"] != "home" || h.Outcomes["h2"] != "away" || h.Outcomes["910"] != "1" {
		t.Fatalf("handicap description: %+v", h)
	}
	if tt := byPMID[1000305]; tt.Name != "Тотал {threshold}" || tt.Outcomes["over"] != "Больше" || tt.Outcomes["under"] != "Меньше" {
		t.Fatalf("total description: %+v", tt)
	}
	if got := VariantTemplate("1-й тайм", "Фора {handicap}"); got != "1-й тайм: Фора {handicap}" {
		t.Fatalf("variant template: %q", got)
	}
}

// A line table's team column is named by number, and the side word may
// only replace that caption when the caption is ALL there is. Fonbet
// runs a handful of multi-row line tables whose captions carry the row
// ("1st substitution 1", "Handicap from 1 to 6 min 2"); every row there
// collapses onto the same side id, so the row text is the outcome's only
// identity and must survive.
func TestOutcomeTemplateTeamColumns(t *testing.T) {
	line := &fonbet.TableMeta{Num: 304, Name: "Handicap", Param: fonbet.ParamHandicap}
	cases := []struct {
		name   string
		factor fonbet.FactorMeta
		want   string
	}{
		{"bare home column", fonbet.FactorMeta{Table: line, Label: "1", SideID: "h1"}, "home"},
		{"bare away column", fonbet.FactorMeta{Table: line, Label: "2", SideID: "h2"}, "away"},
		{"row label survives", fonbet.FactorMeta{Table: line, Label: "1st substitution 1", SideID: "h1"}, "1st substitution 1"},
		{"caption is not the side it sits under", fonbet.FactorMeta{Table: line, Label: "2", SideID: "h1"}, "2"},
		// A plain (unparameterised) table has no side ids at all, so a
		// correct-score cell captioned "1" keeps its number.
		{"no side id", fonbet.FactorMeta{Table: &fonbet.TableMeta{Num: 8, Name: "Correct score"}, Label: "1"}, "1"},
	}
	for _, c := range cases {
		if got := OutcomeTemplate(&c.factor, "en"); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func keys(m map[string]*Market) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func keys2(m map[string]*Outcome) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func findMatch(snap *Snapshot, eventID int64) *Match {
	for _, m := range snap.Matches {
		if m.EventID == eventID {
			return m
		}
	}
	return nil
}

func TestNestedSubEventInheritsParent(t *testing.T) {
	resp, idx := loadFixtures(t)
	// Synthesize a level-3 "угловые" under the Dinamo match's "1-й тайм".
	var half *fonbet.Event
	for i := range resp.Events {
		if resp.Events[i].ParentID == 67372824 && resp.Events[i].Name == "1-й тайм" {
			half = &resp.Events[i]
		}
	}
	if half == nil {
		t.Skip("fixture has no 1st-half sub-event")
	}
	child := fonbet.Event{ID: 999999901, ParentID: half.ID, Level: 3, SportID: half.SportID, Kind: 400100, Name: "угловые", StartTime: half.StartTime, Place: "line"}
	resp.Events = append(resp.Events, child)
	resp.CustomFactors = append(resp.CustomFactors, fonbet.EventFactors{EventID: child.ID, Factors: []fonbet.Factor{{F: 930, V: 1.8, PT: "4.5"}, {F: 931, V: 1.9, PT: "4.5"}}})
	snap := Build(resp, idx, Options{IncludeSubEvents: true})
	m := findMatch(snap, 67372824)
	mk := m.Markets["1000305|threshold=4.5|variant=fb:100201/400100"]
	if mk == nil {
		t.Fatalf("nested market missing; keys=%v", keys(m.Markets))
	}
	if mk.VariantLabel != "1-й тайм угловые" {
		t.Fatalf("nested label: %q", mk.VariantLabel)
	}
}

func TestNegateLine(t *testing.T) {
	if negateLine("2.5") != "-2.5" || negateLine("-1") != "1" || negateLine("0") != "0" {
		t.Fatalf("negateLine")
	}
}

// Regression: with MaxMatches set, len(snap.Matches) is pinned at the cap,
// so the ingester's partial-snapshot guard must read the pre-cap total and
// must not treat the cut-off events as vanished from the feed.
func TestBuildMaxMatchesReportsTotalAndCapped(t *testing.T) {
	resp, idx := loadFixtures(t)
	full := Build(resp, idx, Options{IncludeSubEvents: true})
	if full.TotalMatches != len(full.Matches) || full.Capped != nil {
		t.Fatalf("uncapped: total=%d len=%d capped=%v", full.TotalMatches, len(full.Matches), full.Capped)
	}
	if len(full.Matches) < 2 {
		t.Skip("fixture carries fewer than two matches")
	}
	capped := Build(resp, idx, Options{IncludeSubEvents: true, MaxMatches: 1})
	if len(capped.Matches) != 1 {
		t.Fatalf("cap not applied: %d", len(capped.Matches))
	}
	if capped.TotalMatches != len(full.Matches) {
		t.Fatalf("TotalMatches = %d, want pre-cap %d", capped.TotalMatches, len(full.Matches))
	}
	if len(capped.Capped) != len(full.Matches)-1 {
		t.Fatalf("Capped has %d ids, want %d", len(capped.Capped), len(full.Matches)-1)
	}
	for _, m := range full.Matches[1:] {
		if _, ok := capped.Capped[m.EventID]; !ok {
			t.Fatalf("event %d cut by the cap is not in Capped", m.EventID)
		}
	}
	if _, ok := capped.Capped[capped.Matches[0].EventID]; ok {
		t.Fatalf("kept match %d must not be in Capped", capped.Matches[0].EventID)
	}
	if capped.Skipped["max_matches"] != len(full.Matches)-1 {
		t.Fatalf("skipped[max_matches] = %d", capped.Skipped["max_matches"])
	}
}

// buildScore lifts the serve marker off whichever score group carries it.
// Fonbet puts it on the innermost cell, and that is NOT the same group per
// sport: tennis marks the current game (group 2), table tennis and
// volleyball the current set (group 1). Shapes taken verbatim from a live
// fon.bet snapshot, 2026-09-06.
func TestBuildScoreServe(t *testing.T) {
	serve := func(v int) *int { return &v }
	cases := []struct {
		name string
		info fonbet.LiveEventInfo
		want int
	}{
		{
			name: "tennis marks the current game",
			info: fonbet.LiveEventInfo{
				ScoreComment: "(6-7 4-6 4-4)",
				Scores: [][]fonbet.ScoreCell{
					{{C1: "0", C2: "2"}},
					{{C1: "6", C2: "7", Title: "set"}, {C1: "4", C2: "4", Title: "set"}},
					{{C1: "15", C2: "30", Title: "game", Serve: serve(1)}},
				},
			},
			want: 1,
		},
		{
			name: "table tennis marks the current set",
			info: fonbet.LiveEventInfo{
				ScoreComment: "(11-7 14-16 0-0*)",
				Scores: [][]fonbet.ScoreCell{
					{{C1: "1", C2: "1"}},
					{{C1: "0", C2: "0", Title: "set", Serve: serve(2)}},
				},
			},
			want: 2,
		},
		{
			name: "football carries none",
			info: fonbet.LiveEventInfo{
				Scores: [][]fonbet.ScoreCell{
					{{C1: "0", C2: "0"}},
					{{C1: "0", C2: "0", Title: "half"}},
				},
			},
			want: 0,
		},
		{
			name: "a value that is not a side is dropped",
			info: fonbet.LiveEventInfo{
				Scores: [][]fonbet.ScoreCell{
					{{C1: "0", C2: "0"}},
					{{C1: "1", C2: "2", Title: "set", Serve: serve(3)}},
				},
			},
			want: 0,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			info := tc.info
			got := buildScore(nil, &info)
			if got == nil {
				t.Fatalf("buildScore returned nil")
			}
			if got.Serve != tc.want {
				t.Fatalf("serve = %d, want %d", got.Serve, tc.want)
			}
		})
	}
}

func TestMarketTypeOfInvertsTheIDScheme(t *testing.T) {
	// The settlement grader reaches idx.Tables[n] through this, so it is a
	// money path: a wrong table number grades a market off the wrong
	// statistic. Both namespaces, and the real table 120 that the
	// "Match result" family lives on.
	for _, tc := range []struct {
		pmid  int
		table int
		dc    bool
	}{
		{PMIDBase + 120, 120, false},
		{PMIDBase + 304, 304, false},
		{PMIDBase + 25020, 25020, false},
		{DoubleChancePMIDBase + 120, 120, true},
		{DoubleChancePMIDBase + 1, 1, true},
	} {
		table, dc := MarketTypeOf(tc.pmid)
		if table != tc.table || dc != tc.dc {
			t.Errorf("MarketTypeOf(%d) = (%d, %v), want (%d, %v)",
				tc.pmid, table, dc, tc.table, tc.dc)
		}
	}
	// Round-trips against how the ids are built.
	for _, num := range []int{1, 120, 304, 2800, 25020} {
		if table, dc := MarketTypeOf(PMIDBase + num); table != num || dc {
			t.Errorf("plain %d -> (%d, %v)", num, table, dc)
		}
		if table, dc := MarketTypeOf(DoubleChancePMIDBase + num); table != num || !dc {
			t.Errorf("dc %d -> (%d, %v)", num, table, dc)
		}
	}
}
