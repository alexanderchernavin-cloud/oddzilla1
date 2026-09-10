package sportradar

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return raw
}

func TestParseTimelineMatchAndClock(t *testing.T) {
	tl, err := Parse(readFixture(t, "match_timeline_71036316.json"))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if tl.Kind != "match_timeline" || tl.DOB != 1788988941 || tl.MaxAge != 60 {
		t.Errorf("envelope: kind=%s dob=%d maxage=%d", tl.Kind, tl.DOB, tl.MaxAge)
	}
	m := tl.Match
	if m.ID != 71036316 || m.SportID != BasketballSportID {
		t.Errorf("match id/sport: %d %d", m.ID, m.SportID)
	}
	if m.Teams.Home.Name != "Italy" || m.Teams.Away.Name != "Australia" {
		t.Errorf("teams: %q %q", m.Teams.Home.Name, m.Teams.Away.Name)
	}
	if m.Result.Home == nil || *m.Result.Home != 80 || m.Result.Away == nil || *m.Result.Away != 82 {
		t.Errorf("result: %v %v", m.Result.Home, m.Result.Away)
	}
	if lvl := m.CoverageLevel(); lvl == nil || *lvl != 3 {
		t.Errorf("coverage level: %v", lvl)
	}
	// timeinfo.played is a STRING in the feed; ended_uts a number here and
	// `false` while a match is on.
	c := m.Clock()
	if c.Seconds != 2100 {
		t.Errorf("clock seconds: %d", c.Seconds)
	}
	if !c.Started || !c.Ended {
		t.Errorf("started/ended: %v %v", c.Started, c.Ended)
	}
	// The feed leaves running=true on an ended fixture; the reading must
	// not, or the api would accept a spin on a finished game.
	if c.Running {
		t.Error("running must be false once ended")
	}
	if c.Period != nil {
		t.Errorf("period after the end must be nil, got %d", *c.Period)
	}
	if lag := tl.FeedLag(time.Unix(1788988950, 0)); lag != 9*time.Second {
		t.Errorf("feed lag: %v", lag)
	}
}

func TestParseTimelineRows(t *testing.T) {
	tl, err := Parse(readFixture(t, "match_timeline_71036316.json"))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(tl.Events) != 40 {
		t.Fatalf("events: want 40, got %d", len(tl.Events))
	}
	rows := tl.Rows()
	// Six events carry seconds -1 (players on court, warming up, about to
	// start, started, timeinfo, period start) and must be skipped.
	if len(rows) != 34 {
		t.Fatalf("rows: want 34, got %d", len(rows))
	}
	bySymbol := map[string]int{}
	byID := map[int64]EventRow{}
	for _, r := range rows {
		if r.SrMatchID != 71036316 {
			t.Errorf("row %d sr_match_id %d", r.SrEventID, r.SrMatchID)
		}
		if r.Seconds < 0 {
			t.Errorf("row %d has seconds %d", r.SrEventID, r.Seconds)
		}
		if len(r.Raw) == 0 {
			t.Errorf("row %d has no raw json", r.SrEventID)
		}
		bySymbol[r.Symbol]++
		byID[r.SrEventID] = r
	}
	// 8 goals (2 pt / free throws), 4 misses, 4 fouls; rebounds, clock and
	// free-throws-awarded events make no symbol.
	if bySymbol["MISS"] != 4 || bySymbol["FOUL"] != 4 || bySymbol["P2"]+bySymbol["FT"]+bySymbol["P3"] != 8 {
		t.Errorf("symbol counts: %v", bySymbol)
	}
	if bySymbol[""] != 34-16 {
		t.Errorf("no-symbol rows: %d (%v)", bySymbol[""], bySymbol)
	}
	goal := byID[2458477790]
	if goal.Type != "goal" || goal.Symbol != "P2" || goal.Team != "away" || goal.Seconds != 14 || goal.Points == nil || *goal.Points != 2 {
		t.Errorf("first goal row: %+v", goal)
	}
	if goal.UTS != 1788979558 || goal.UpdatedUTS != 1788979558 || goal.Disabled {
		t.Errorf("first goal stamps: %+v", goal)
	}
	miss := byID[2458478122]
	if miss.Symbol != "MISS" || miss.Team != "home" || miss.Seconds != 37 {
		t.Errorf("miss row: %+v", miss)
	}
	foul := byID[2458478230]
	if foul.Symbol != "FOUL" || foul.Team != "away" || foul.Seconds != 44 || foul.UpdatedUTS != 1788979589 {
		t.Errorf("foul row: %+v", foul)
	}
	clock := byID[2458478232]
	if clock.Type != "timerunning" || clock.Symbol != "" || clock.Team != "" {
		t.Errorf("timerunning row: %+v", clock)
	}
	// Level 3 coverage: no scorer on goals, so no player columns.
	if goal.PlayerID != nil || goal.PlayerName != "" {
		t.Errorf("level-3 goal must carry no player: %+v", goal)
	}
}

func TestParseDelta(t *testing.T) {
	tl, err := Parse(readFixture(t, "match_timelinedelta_71036316.json"))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if tl.Kind != "match_timelinedelta" || tl.DOB != 1788988933 {
		t.Errorf("envelope: %s %d", tl.Kind, tl.DOB)
	}
	if len(tl.Events) != 0 || len(tl.Rows()) != 0 {
		t.Errorf("ended delta carries events: %d", len(tl.Events))
	}
	if !tl.Match.IsEnded() || tl.Match.Status.Name != "Ended" {
		t.Error("delta must read as ended")
	}
	if tl.Match.EndedUTS.Value != 1788986451 || !tl.Match.EndedUTS.Valid {
		t.Errorf("ended_uts: %+v", tl.Match.EndedUTS)
	}
}

func TestParseException(t *testing.T) {
	_, err := Parse(readFixture(t, "exception.json"))
	if err == nil {
		t.Fatal("exception document must be an error")
	}
	var ex *ExceptionError
	if !errors.As(err, &ex) {
		t.Fatalf("want *ExceptionError, got %T: %v", err, err)
	}
	if ex.Message != "No such match" || ex.Name != "InvalidArgument" || ex.Query != "match_timeline/1" {
		t.Errorf("exception fields: %+v", ex)
	}
}

func TestFlexScalars(t *testing.T) {
	tl, err := Parse([]byte(`{"queryUrl":"x","doc":[{"event":"match_timelinedelta","_dob":1,"_maxage":3,"data":{"match":{"_id":5,"_sid":2,"p":"2","timeinfo":{"played":"612","remaining":"588","running":true,"started":"1788979543","ended":null},"ended_uts":false,"status":{"name":"2nd quarter"}},"events":[{"_id":9,"type":"goal","seconds":600,"team":"home","points":3,"disabled":1,"scorer":{"_id":77,"name":"A. Player"}},{"_id":0,"type":"goal","seconds":1}]}}]}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	c := tl.Match.Clock()
	if c.Seconds != 612 || !c.Running || c.Ended || !c.Started || c.Period == nil || *c.Period != 2 {
		t.Errorf("clock: %+v", c)
	}
	rows := tl.Rows()
	if len(rows) != 1 {
		t.Fatalf("rows: %d (an event without an id is dropped)", len(rows))
	}
	r := rows[0]
	if r.Symbol != "P3" || !r.Disabled || r.PlayerID == nil || *r.PlayerID != 77 || r.PlayerName != "A. Player" {
		t.Errorf("row: %+v", r)
	}
	if r.UpdatedUTS != r.UTS {
		t.Errorf("missing updated_uts must fall back to uts: %+v", r)
	}
}

func TestParseRejectsEmptyEnvelope(t *testing.T) {
	if _, err := Parse([]byte(`{"queryUrl":"x","doc":[]}`)); err == nil {
		t.Error("empty doc must be an error")
	}
	if _, err := Parse([]byte(`not json`)); err == nil {
		t.Error("garbage must be an error")
	}
	if _, err := Parse([]byte(`{"queryUrl":"x","doc":[{"event":"match_timeline","data":{"match":{},"events":[]}}]}`)); err == nil {
		t.Error("a document without a match id must be an error")
	}
}
