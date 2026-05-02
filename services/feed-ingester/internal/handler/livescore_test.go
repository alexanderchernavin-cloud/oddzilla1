package handler

import (
	"encoding/json"
	"encoding/xml"
	"testing"

	"github.com/oddzilla/feed-ingester/internal/oddinxml"
)

// helper to dereference int pointers in tests, treating nil as a sentinel.
func ptr(n int) *int { return &n }

func TestBuildLiveScore_NilInput(t *testing.T) {
	out, err := buildLiveScore(nil, 0)
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if out != nil {
		t.Fatalf("expected nil payload, got %s", string(out))
	}
}

func TestBuildLiveScore_EmptyStatusReturnsNil(t *testing.T) {
	s := &oddinxml.SportEventStatus{}
	out, err := buildLiveScore(s, 1700000000000)
	if err != nil {
		t.Fatal(err)
	}
	if out != nil {
		t.Fatalf("expected nil payload for empty status, got %s", string(out))
	}
}

func TestBuildLiveScore_CS2_LiveSecondMap(t *testing.T) {
	// Series 1-0; map 1 finished 16-12 for home; map 2 in progress at 5-7.
	s := &oddinxml.SportEventStatus{
		Status:      ptr(1), // live
		MatchStatus: ptr(6),
		HomeScore:   ptr(1),
		AwayScore:   ptr(0),
		PeriodScores: &oddinxml.PeriodScores{
			Periods: []oddinxml.PeriodScore{
				{
					Number:          ptr(1),
					Type:            "map",
					MatchStatusCode: ptr(100), // ended
					HomeScore:       ptr(16),
					AwayScore:       ptr(12),
					HomeWonRounds:   ptr(16),
					AwayWonRounds:   ptr(12),
				},
				{
					Number:          ptr(2),
					Type:            "map",
					MatchStatusCode: ptr(6), // in progress
					HomeScore:       ptr(5),
					AwayScore:       ptr(7),
					HomeWonRounds:   ptr(5),
					AwayWonRounds:   ptr(7),
				},
			},
		},
		Scoreboard: &oddinxml.Scoreboard{
			HomeWonRounds: ptr(5),
			AwayWonRounds: ptr(7),
		},
	}
	raw, err := buildLiveScore(s, 1700000000000)
	if err != nil {
		t.Fatal(err)
	}
	if raw == nil {
		t.Fatal("expected non-nil payload")
	}
	var got liveScorePayload
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Home == nil || *got.Home != 1 || got.Away == nil || *got.Away != 0 {
		t.Errorf("series score wrong: %+v / %+v", got.Home, got.Away)
	}
	if got.CurrentMap == nil || *got.CurrentMap != 2 {
		t.Errorf("currentMap = %v, want 2", got.CurrentMap)
	}
	if len(got.Periods) != 2 {
		t.Fatalf("expected 2 periods, got %d", len(got.Periods))
	}
	if got.Periods[0].IsLive {
		t.Error("map 1 should not be marked live")
	}
	if !got.Periods[1].IsLive {
		t.Error("map 2 should be marked live")
	}
}

func TestBuildLiveScore_CurrentMap_CountStartedPeriods(t *testing.T) {
	// One started/finished period (rounds played), one not started yet.
	// No code=6 anywhere — must fall back to "started count + 1".
	s := &oddinxml.SportEventStatus{
		Status:    ptr(1),
		HomeScore: ptr(1),
		AwayScore: ptr(0),
		PeriodScores: &oddinxml.PeriodScores{
			Periods: []oddinxml.PeriodScore{
				{
					Number: ptr(1), Type: "map", MatchStatusCode: ptr(100),
					HomeWonRounds: ptr(16), AwayWonRounds: ptr(12),
				},
				{Number: ptr(2), Type: "map", MatchStatusCode: ptr(101)},
			},
		},
	}
	cm := deriveCurrentMap(s)
	if cm == nil || *cm != 2 {
		t.Fatalf("expected currentMap=2, got %v", cm)
	}
}

func TestBuildLiveScore_CurrentMap_NilWithoutPeriods(t *testing.T) {
	// No periods → cannot infer current period number. Top-level series
	// score must NOT be summed (it's points/goals for non-map sports).
	s := &oddinxml.SportEventStatus{
		Status:    ptr(1),
		HomeScore: ptr(2),
		AwayScore: ptr(1),
	}
	if cm := deriveCurrentMap(s); cm != nil {
		t.Fatalf("expected nil currentMap without periods, got %v", cm)
	}
}

func TestBuildLiveScore_CurrentMap_BasketballQuarters(t *testing.T) {
	// Real production basketball shape: home_score=20, away_score=53 are
	// game points (not maps won). Must NOT compute currentMap = 74.
	s := &oddinxml.SportEventStatus{
		Status:    ptr(1),
		HomeScore: ptr(20),
		AwayScore: ptr(53),
		PeriodScores: &oddinxml.PeriodScores{
			Periods: []oddinxml.PeriodScore{
				{Number: ptr(1), Type: "quarter", HomeScore: ptr(6), AwayScore: ptr(18)},
				{Number: ptr(2), Type: "quarter", HomeScore: ptr(6), AwayScore: ptr(18)},
				{Number: ptr(3), Type: "quarter", HomeScore: ptr(8), AwayScore: ptr(17)},
				{Number: ptr(4), Type: "quarter", HomeScore: ptr(0), AwayScore: ptr(0)},
			},
		},
	}
	cm := deriveCurrentMap(s)
	if cm == nil || *cm != 4 {
		t.Fatalf("expected currentMap=4 (basketball Q4), got %v", cm)
	}
}

// Real production shape captured from Oddin (2026-05-02): map 1 finished
// with rounds 13-11 (home won, series 1-0); maps 2 and 3 both report 0-0
// with no round attrs and use Oddin's CS2-specific match_status_codes 51,
// 52, 53 (NOT the generic UOF "6 = in progress"). The current map should
// be 2 — derived from the series score, not from match_status_code.
func TestBuildLiveScore_CS2_RealOddinShape(t *testing.T) {
	body := []byte(`<sport_event_status home_score="1" away_score="0" status="1" scoreboard_available="true" match_status="52">
  <period_scores>
    <period_score type="map" number="1" match_status_code="51" home_score="1" away_score="0" home_won_rounds="13" away_won_rounds="11"/>
    <period_score type="map" number="2" match_status_code="52" home_score="0" away_score="0"/>
    <period_score type="map" number="3" match_status_code="53" home_score="0" away_score="0"/>
  </period_scores>
  <scoreboard></scoreboard>
</sport_event_status>`)
	var s oddinxml.SportEventStatus
	if err := xml.Unmarshal(body, &s); err != nil {
		t.Fatal(err)
	}
	cm := deriveCurrentMap(&s)
	if cm == nil || *cm != 2 {
		t.Fatalf("expected currentMap=2 from real CS2 shape, got %v", cm)
	}
	raw, err := buildLiveScore(&s, 1700000000000)
	if err != nil || raw == nil {
		t.Fatalf("buildLiveScore: raw=%v err=%v", raw, err)
	}
	var got liveScorePayload
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.Home == nil || *got.Home != 1 || got.Away == nil || *got.Away != 0 {
		t.Errorf("series score: %v / %v, want 1 / 0", got.Home, got.Away)
	}
	if len(got.Periods) != 3 {
		t.Fatalf("expected 3 periods, got %d", len(got.Periods))
	}
	// Period 2 must be flagged live since currentMap=2.
	if !got.Periods[1].IsLive {
		t.Error("period 2 should be flagged isLive")
	}
	if got.Periods[0].IsLive || got.Periods[2].IsLive {
		t.Error("only period 2 should be live")
	}
}

func TestBuildLiveScore_CurrentMap_NilWhenSeriesEnded(t *testing.T) {
	// status>=3 means the series has ended/closed/cancelled.
	s := &oddinxml.SportEventStatus{
		Status:    ptr(4),
		HomeScore: ptr(2),
		AwayScore: ptr(1),
		PeriodScores: &oddinxml.PeriodScores{
			Periods: []oddinxml.PeriodScore{
				{Number: ptr(1), MatchStatusCode: ptr(100)},
				{Number: ptr(2), MatchStatusCode: ptr(100)},
				{Number: ptr(3), MatchStatusCode: ptr(100)},
			},
		},
	}
	if cm := deriveCurrentMap(s); cm != nil {
		t.Fatalf("expected nil currentMap when series ended, got %v", cm)
	}
}

// Decoding integration test: the XML shape we expect from Oddin must
// round-trip cleanly through our struct definitions. Catches future
// XSD drift the moment it lands in a fixture.
func TestSportEventStatus_XMLDecode(t *testing.T) {
	body := []byte(`
<odds_change product="2" event_id="od:match:99" timestamp="1700000000000">
  <sport_event_status status="1" match_status="6" home_score="1" away_score="0" scoreboard_available="true">
    <period_scores>
      <period_score number="1" type="map" match_status_code="100" home_score="16" away_score="12" home_won_rounds="16" away_won_rounds="12"/>
      <period_score number="2" type="map" match_status_code="6" home_score="5" away_score="7" home_won_rounds="5" away_won_rounds="7"/>
    </period_scores>
    <scoreboard home_won_rounds="5" away_won_rounds="7" current_ct_team="1" current_def_team="2" time="12:34"/>
  </sport_event_status>
  <odds/>
</odds_change>`)
	var oc oddinxml.OddsChange
	if err := xml.Unmarshal(body, &oc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if oc.SportEventStatus == nil {
		t.Fatal("sport_event_status missing after decode")
	}
	s := oc.SportEventStatus
	if s.HomeScore == nil || *s.HomeScore != 1 {
		t.Errorf("home_score: %v", s.HomeScore)
	}
	if s.PeriodScores == nil || len(s.PeriodScores.Periods) != 2 {
		t.Fatalf("expected 2 periods, got %+v", s.PeriodScores)
	}
	p2 := s.PeriodScores.Periods[1]
	if p2.HomeWonRounds == nil || *p2.HomeWonRounds != 5 {
		t.Errorf("map 2 home_won_rounds: %v", p2.HomeWonRounds)
	}
	if s.Scoreboard == nil || s.Scoreboard.Time != "12:34" {
		t.Errorf("scoreboard time: %+v", s.Scoreboard)
	}
}
