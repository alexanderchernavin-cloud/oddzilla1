package settle

import (
	"encoding/json"
	"testing"

	"github.com/oddzilla/fonbet-ingester/internal/fonbet"
	"github.com/oddzilla/fonbet-ingester/internal/store"
)

// resultsDoc builds one results document with a single section holding the
// given match rows (all sharing competition 58540 and start time 1000).
func resultsDoc(names ...string) *fonbet.ResultsResponse {
	doc := &fonbet.ResultsResponse{}
	sec := fonbet.ResultSection{ID: 1, FonbetSportID: 1, FonbetCompetitionID: 58540}
	for i, n := range names {
		doc.Events = append(doc.Events, fonbet.ResultEvent{
			ID: json.Number(string(rune('1' + i))), Name: n, Score: "1:0", StartTime: 1000, Status: fonbet.ResultFinished,
		})
		sec.Events = append(sec.Events, i+1)
	}
	doc.Sections = []fonbet.ResultSection{sec}
	return doc
}

func pending(home, away string) store.PendingMatch {
	return store.PendingMatch{HomeTeam: home, AwayTeam: away, StartTime: 1000, SegmentID: 58540}
}

// Legacy fixtures hold Cyrillic team names the English results feed can
// never spell; the (competition, start time) key stands in exactly when it
// is unambiguous on both sides.
func TestResultIndexFindCyrillicFallback(t *testing.T) {
	ri := buildResultIndex([]*fonbet.ResultsResponse{resultsDoc("Rubin – Orenburg")})

	m := pending("Рубин", "Оренбург")
	m.SameSlot = 1
	if rm := ri.find(m); rm == nil || rm.name != "rubin – orenburg" {
		t.Fatalf("one Cyrillic fixture, one results row at the key: must match, got %+v", rm)
	}
	// Two fixtures of ours in that slot: ambiguous, refuse.
	m.SameSlot = 2
	if rm := ri.find(m); rm != nil {
		t.Fatalf("two fixtures in the slot must refuse, got %+v", rm)
	}
	// Two results rows at the key: ambiguous, refuse.
	m.SameSlot = 1
	ri2 := buildResultIndex([]*fonbet.ResultsResponse{resultsDoc("Rubin – Orenburg", "Zenit – Spartak")})
	if rm := ri2.find(m); rm != nil {
		t.Fatalf("two results rows at the key must refuse, got %+v", rm)
	}
	// Latin names that simply do not match stay unmatched — the fallback
	// is for the language gap only.
	l := pending("Lokomotiv", "Dynamo")
	l.SameSlot = 1
	if rm := ri.find(l); rm != nil {
		t.Fatalf("a Latin mismatch must not borrow the slot, got %+v", rm)
	}
}

func TestResultIndexFindExact(t *testing.T) {
	ri := buildResultIndex([]*fonbet.ResultsResponse{resultsDoc("Оренбург – Рубин", "Зенит – Спартак")})
	if rm := ri.find(pending("Оренбург", "Рубин")); rm == nil || rm.name != "оренбург – рубин" {
		t.Fatalf("exact match: %+v", rm)
	}
	// dash variants and whitespace normalise to the same key
	ri = buildResultIndex([]*fonbet.ResultsResponse{resultsDoc("Оренбург  -  Рубин")})
	if rm := ri.find(pending("Оренбург", "Рубин")); rm == nil {
		t.Fatalf("normalised dash must match")
	}
}

// Regression: the fallback matched any row containing both names, so the
// mirrored fixture "Рубин – Оренбург" bound to home=Оренбург and every
// home/away grade on the match settled inverted. Home must precede away.
func TestResultIndexFindRejectsMirroredRow(t *testing.T) {
	ri := buildResultIndex([]*fonbet.ResultsResponse{resultsDoc("Рубин – Оренбург")})
	if rm := ri.find(pending("Оренбург", "Рубин")); rm != nil {
		t.Fatalf("mirrored row must not match, got %q", rm.name)
	}
	// The ordered fallback still binds a row whose names carry extra
	// decoration (sponsor suffix, city) in the right order.
	ri = buildResultIndex([]*fonbet.ResultsResponse{resultsDoc("ФК Оренбург (Оренбург) – Рубин Казань")})
	if rm := ri.find(pending("Оренбург", "Рубин")); rm == nil {
		t.Fatalf("ordered fallback must match decorated names")
	}
	// A pending match with an empty side never falls back.
	if rm := ri.find(pending("", "Рубин")); rm != nil {
		t.Fatalf("empty home must not fall back, got %q", rm.name)
	}
}

func TestResultIndexFindPrefersExactOverFallback(t *testing.T) {
	// Both rows contain both names in order; the exact one must win.
	ri := buildResultIndex([]*fonbet.ResultsResponse{resultsDoc("Барселона Б – Реал Мадрид Кастилья", "Барселона – Реал Мадрид")})
	if rm := ri.find(pending("Барселона", "Реал Мадрид")); rm == nil || rm.name != "барселона – реал мадрид" {
		t.Fatalf("exact row must win over decorated row, got %+v", rm)
	}
}
