package translate

import (
	"encoding/base64"
	"encoding/xml"
	"math"
	"strconv"
	"strings"
	"testing"

	"github.com/oddzilla/bifrost-feed/internal/bifrost"
)

// Decode-side structs copied from services/feed-ingester/internal/oddinxml
// so the test asserts what the real consumer will see, not what we meant.
type oddsChange struct {
	XMLName          xml.Name `xml:"odds_change"`
	EventID          string   `xml:"event_id,attr"`
	Product          int      `xml:"product,attr"`
	Timestamp        int64    `xml:"timestamp,attr"`
	SportEventStatus *struct {
		Status    *int `xml:"status,attr"`
		HomeScore *int `xml:"home_score,attr"`
		AwayScore *int `xml:"away_score,attr"`
		Periods   *struct {
			Rows []struct {
				Number          *int   `xml:"number,attr"`
				Type            string `xml:"type,attr"`
				MatchStatusCode *int   `xml:"match_status_code,attr"`
				HomeWonRounds   *int   `xml:"home_won_rounds,attr"`
				AwayWonRounds   *int   `xml:"away_won_rounds,attr"`
				HomeKills       *int   `xml:"home_kills,attr"`
			} `xml:"period_score"`
		} `xml:"period_scores"`
		Scoreboard *struct {
			HomeWonRounds *int `xml:"home_won_rounds,attr"`
		} `xml:"scoreboard"`
	} `xml:"sport_event_status"`
	Odds *struct {
		Markets []struct {
			ID         int    `xml:"id,attr"`
			Specifiers string `xml:"specifiers,attr"`
			Status     int    `xml:"status,attr"`
			Name       string `xml:"name,attr"`
			Outcomes   []struct {
				ID          string `xml:"id,attr"`
				Odds        string `xml:"odds,attr"`
				Active      *int   `xml:"active,attr"`
				Probability string `xml:"probabilities,attr"`
				Name        string `xml:"name,attr"`
			} `xml:"outcome"`
		} `xml:"market"`
	} `xml:"odds"`
}

type betSettlement struct {
	XMLName   xml.Name `xml:"bet_settlement"`
	EventID   string   `xml:"event_id,attr"`
	Certainty int      `xml:"certainty,attr"`
	Outcomes  struct {
		Markets []struct {
			ID         int    `xml:"id,attr"`
			Specifiers string `xml:"specifiers,attr"`
			Outcomes   []struct {
				ID         string `xml:"id,attr"`
				Result     string `xml:"result,attr"`
				VoidFactor string `xml:"void_factor,attr"`
			} `xml:"outcome"`
		} `xml:"market"`
	} `xml:"outcomes"`
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func f(v float64) *float64 { return &v }

func intp(v int) *int { return &v }

// sampleMatch mirrors the live Dota 2 snapshot captured on 2026-09-03
// (PuckChamp v Team Spirit Academy, od:match:3139010), with one market
// already settled and one outcome suspended, so every branch fires.
func sampleMatch(state string) *bifrost.Match {
	const urn = "od:match:3139010"
	return &bifrost.Match{
		ID:               b64("match/" + urn),
		State:            state,
		DatePlannedStart: "2026-09-03T12:02:00Z",
		Tournament: &bifrost.Tournament{
			ID:    b64("tournament/od:tournament:14611"),
			Name:  "EPL Masters II",
			Sport: &bifrost.Sport{ID: b64("sport/od:sport:2"), Name: "Dota 2"},
		},
		Teams: []bifrost.MatchTeam{
			{Team: bifrost.Team{ID: b64("team/od:competitor:1655"), Name: "PuckChamp"}},
			{Team: bifrost.Team{ID: b64("team/od:competitor:2854"), Name: "Team Spirit Academy"}},
		},
		SimpleScore: &bifrost.SimpleScore{
			Home: "0", Away: "1", PeriodType: "MAP", ActivePeriodIdx: intp(1), TotalPeriods: 2,
			Periods: []bifrost.SimpleScorePeriod{{Number: 1, Home: "12", Away: "34"}, {Number: 2, Home: "25", Away: "25"}},
		},
		MarketGroups: []bifrost.MarketGroup{
			{
				Name: "Winner",
				Selections: []bifrost.Selection{
					{ID: b64("market_group_selection/" + urn + "/1|variant=way:two/1"), Name: "PuckChamp"},
					{ID: b64("market_group_selection/" + urn + "/1|variant=way:two/2"), Name: "Team Spirit Academy"},
				},
				Markets: []bifrost.Market{{
					ID:    b64("market/" + urn + "/1|variant=way:two/1-variant=way:two|way=two"),
					State: bifrost.MarketOpen,
					Outcomes: []bifrost.Outcome{
						{ID: b64("outcome/" + urn + "/1|variant=way:two/1-variant=way:two|way=two/1"), Odds: f(9), Status: bifrost.OutcomeOpen},
						{ID: b64("outcome/" + urn + "/1|variant=way:two/1-variant=way:two|way=two/2"), Odds: f(1.03), Status: bifrost.OutcomeOpen},
					},
				}},
			},
			{
				Name: "Handicap",
				Markets: []bifrost.Market{{
					ID:    b64("market/" + urn + "/2/2-handicap=-1.5"),
					State: bifrost.MarketSuspended,
					Outcomes: []bifrost.Outcome{
						{ID: b64("outcome/" + urn + "/2/2-handicap=-1.5/1"), Odds: f(5.3), Status: bifrost.OutcomeSuspended},
						{ID: b64("outcome/" + urn + "/2/2-handicap=-1.5/2"), Odds: f(1.12), Status: bifrost.OutcomeSuspended},
					},
				}},
			},
			{
				Name: "Map 1 Winner", Category: "MAP_1",
				Markets: []bifrost.Market{{
					ID:    b64("market/" + urn + "/6|variant=way:two|map=1/6-map=1|variant=way:two|way=two"),
					State: bifrost.MarketClosed,
					Outcomes: []bifrost.Outcome{
						{ID: b64("outcome/" + urn + "/6|variant=way:two|map=1/6-map=1|variant=way:two|way=two/1"), Status: bifrost.OutcomeLost},
						{ID: b64("outcome/" + urn + "/6|variant=way:two|map=1/6-map=1|variant=way:two|way=two/2"), Status: bifrost.OutcomeWon},
					},
				}},
			},
			{
				Name: "Map 1 Total Kills", Category: "MAP_1",
				Markets: []bifrost.Market{{
					ID:    b64("market/" + urn + "/34|map=1/34-map=1|threshold=45.5"),
					State: bifrost.MarketClosed,
					Outcomes: []bifrost.Outcome{
						{ID: b64("outcome/" + urn + "/34|map=1/34-map=1|threshold=45.5/4"), Status: bifrost.OutcomeHalfLost},
						{ID: b64("outcome/" + urn + "/34|map=1/34-map=1|threshold=45.5/5"), Status: bifrost.OutcomeHalfWon},
						{ID: b64("outcome/" + urn + "/34|map=1/34-map=1|threshold=45.5/6"), Status: bifrost.OutcomeInactive},
					},
				}},
			},
			{
				Name: "Map 2 Duration", Category: "MAP_2",
				Markets: []bifrost.Market{{
					// CLOSED but one outcome still OPEN: inconsistent, must be skipped.
					ID:    b64("market/" + urn + "/27|map=2/27-map=2|threshold=40"),
					State: bifrost.MarketClosed,
					Outcomes: []bifrost.Outcome{
						{ID: b64("outcome/" + urn + "/27|map=2/27-map=2|threshold=40/4"), Odds: f(1.9), Status: bifrost.OutcomeOpen},
						{ID: b64("outcome/" + urn + "/27|map=2/27-map=2|threshold=40/5"), Status: bifrost.OutcomeVoided},
					},
				}},
			},
		},
	}
}

func TestOddsChangeRoundTrip(t *testing.T) {
	m := sampleMatch(bifrost.MatchStarted)
	body, err := OddsChange(m, 1_700_000_000_000)
	if err != nil {
		t.Fatal(err)
	}
	var got oddsChange
	if err := xml.Unmarshal(body, &got); err != nil {
		t.Fatalf("consumer decode: %v\n%s", err, body)
	}
	if got.EventID != "od:match:3139010" || got.Product != 2 || got.Timestamp != 1_700_000_000_000 {
		t.Fatalf("envelope: %+v", got)
	}
	if got.SportEventStatus == nil || got.SportEventStatus.Status == nil || *got.SportEventStatus.Status != 1 {
		t.Fatalf("expected live status 1, got %+v", got.SportEventStatus)
	}
	if *got.SportEventStatus.HomeScore != 0 || *got.SportEventStatus.AwayScore != 1 {
		t.Fatalf("series score: %+v", got.SportEventStatus)
	}
	rows := got.SportEventStatus.Periods.Rows
	if len(rows) != 2 || rows[0].Type != "map" || *rows[1].HomeKills != 25 {
		t.Fatalf("periods: %+v", rows)
	}
	if rows[0].MatchStatusCode != nil || rows[1].MatchStatusCode == nil || *rows[1].MatchStatusCode != 6 {
		t.Fatalf("live period must carry match_status_code=6 and only it: %+v", rows)
	}
	if rows[0].HomeWonRounds != nil {
		t.Fatalf("Dota is a kills family, rounds must be absent: %+v", rows[0])
	}
	if got.Odds == nil || len(got.Odds.Markets) != 2 {
		t.Fatalf("expected 2 open/suspended markets (closed excluded), got %+v", got.Odds)
	}
	winner := got.Odds.Markets[0]
	if winner.ID != 1 || winner.Specifiers != "variant=way:two|way=two" || winner.Status != 1 {
		t.Fatalf("winner market: %+v", winner)
	}
	if winner.Outcomes[0].Odds != "9" || winner.Outcomes[1].Odds != "1.03" {
		t.Fatalf("odds format: %+v", winner.Outcomes)
	}
	if winner.Name != "Winner" {
		t.Fatalf("market must carry the Bifrost group name: %q", winner.Name)
	}
	if winner.Outcomes[0].Name != "PuckChamp" || winner.Outcomes[1].Name != "Team Spirit Academy" {
		t.Fatalf("outcomes must carry the selection names: %+v", winner.Outcomes)
	}
	handicapNoSel := got.Odds.Markets[1]
	if handicapNoSel.Outcomes[0].Name != "" {
		t.Fatalf("a group without selections must not invent outcome names: %+v", handicapNoSel.Outcomes[0])
	}
	if *winner.Outcomes[0].Active != 1 {
		t.Fatalf("open outcome must be active: %+v", winner.Outcomes[0])
	}
	p0, _ := strconv.ParseFloat(winner.Outcomes[0].Probability, 64)
	p1, _ := strconv.ParseFloat(winner.Outcomes[1].Probability, 64)
	if math.Abs(p0+p1-1) > 0.001 || p0 > p1 {
		t.Fatalf("probabilities must normalise to 1 with the favourite higher: %v %v", p0, p1)
	}
	handicap := got.Odds.Markets[1]
	if handicap.ID != 2 || handicap.Specifiers != "handicap=-1.5" || handicap.Status != -1 {
		t.Fatalf("suspended market must map to -1 with specifiers intact: %+v", handicap)
	}
	if *handicap.Outcomes[0].Active != 0 || handicap.Outcomes[0].Odds != "5.3" {
		t.Fatalf("suspended outcome keeps its last price but is not active: %+v", handicap.Outcomes[0])
	}
}

func TestOddsChangePrematchProductAndNoScore(t *testing.T) {
	m := sampleMatch(bifrost.MatchNotStarted)
	m.SimpleScore = nil
	body, err := OddsChange(m, 1)
	if err != nil {
		t.Fatal(err)
	}
	var got oddsChange
	if err := xml.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.Product != 1 || *got.SportEventStatus.Status != 0 || got.SportEventStatus.Periods != nil {
		t.Fatalf("prematch envelope: %+v", got)
	}
}

// A live match whose whole book is momentarily closed says nothing: that
// is an ordinary between-rounds suspension, not a lifecycle event.
func TestOddsChangeAllClosedLiveMatchReturnsNil(t *testing.T) {
	m := sampleMatch(bifrost.MatchStarted)
	for gi := range m.MarketGroups {
		for mi := range m.MarketGroups[gi].Markets {
			m.MarketGroups[gi].Markets[mi].State = bifrost.MarketClosed
		}
	}
	body, err := OddsChange(m, 1)
	if err != nil || body != nil {
		t.Fatalf("expected nil body for a live all-closed match, got %v %s", err, body)
	}
}

// A CLOSED match with nothing left to quote still has to say it closed.
// Without this message nothing moves matches.status off `live`: the match
// has left the live offer so its subscription is silent, and the
// settlement path can only close it if Bifrost still lists every market
// our catalogue holds open. The message carries the status and no <odds>
// block, which is the shape feed-ingester's handleOddsChange applies to an
// already-known match.
func TestOddsChangeClosedMatchEmitsLifecycleOnly(t *testing.T) {
	m := sampleMatch(bifrost.MatchClosed)
	for gi := range m.MarketGroups {
		for mi := range m.MarketGroups[gi].Markets {
			m.MarketGroups[gi].Markets[mi].State = bifrost.MarketClosed
		}
	}
	body, err := OddsChange(m, 1)
	if err != nil {
		t.Fatal(err)
	}
	if body == nil {
		t.Fatal("a closed match must still voice its terminal status")
	}
	var got oddsChange
	if err := xml.Unmarshal(body, &got); err != nil {
		t.Fatalf("consumer decode: %v -- %s", err, body)
	}
	if got.SportEventStatus == nil || got.SportEventStatus.Status == nil || *got.SportEventStatus.Status != 4 {
		t.Fatalf("expected terminal status 4, got %+v", got.SportEventStatus)
	}
	if got.Odds != nil && len(got.Odds.Markets) != 0 {
		t.Fatalf("lifecycle-only message must carry no markets, got %d", len(got.Odds.Markets))
	}
}

func TestSettleCandidatesAndBetSettlement(t *testing.T) {
	m := sampleMatch(bifrost.MatchStarted)
	cands := SettleCandidates(m)
	if len(cands) != 2 {
		t.Fatalf("expected the two consistent CLOSED markets, got %d: %+v", len(cands), cands)
	}
	body, err := BetSettlement(m, cands, 42)
	if err != nil {
		t.Fatal(err)
	}
	var got betSettlement
	if err := xml.Unmarshal(body, &got); err != nil {
		t.Fatalf("consumer decode: %v\n%s", err, body)
	}
	if got.EventID != "od:match:3139010" || got.Certainty != 1 {
		t.Fatalf("envelope: %+v", got)
	}
	byID := map[int]int{}
	for i, mk := range got.Outcomes.Markets {
		byID[mk.ID] = i
	}
	mapWinner := got.Outcomes.Markets[byID[6]]
	if mapWinner.Specifiers != "map=1|variant=way:two|way=two" {
		t.Fatalf("specifiers must be canonical sorted form: %q", mapWinner.Specifiers)
	}
	if mapWinner.Outcomes[0].Result != "0" || mapWinner.Outcomes[1].Result != "1" || mapWinner.Outcomes[1].VoidFactor != "" {
		t.Fatalf("won/lost mapping: %+v", mapWinner.Outcomes)
	}
	kills := got.Outcomes.Markets[byID[34]]
	if len(kills.Outcomes) != 2 {
		t.Fatalf("INACTIVE outcome must be dropped from settlement: %+v", kills.Outcomes)
	}
	if kills.Outcomes[0].Result != "0" || kills.Outcomes[0].VoidFactor != "0.5" || kills.Outcomes[1].Result != "1" || kills.Outcomes[1].VoidFactor != "0.5" {
		t.Fatalf("half won/lost mapping: %+v", kills.Outcomes)
	}
	if _, present := byID[27]; present {
		t.Fatal("CLOSED market with an OPEN outcome must not be settled")
	}
}

func TestBetSettlementCertaintyPostGame(t *testing.T) {
	m := sampleMatch(bifrost.MatchClosed)
	body, err := BetSettlement(m, SettleCandidates(m), 1)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `certainty="2"`) {
		t.Fatalf("closed match must settle with certainty 2: %s", body)
	}
}

func TestVoidedMapsToFullRefund(t *testing.T) {
	res, vf, ok := settleFor(bifrost.OutcomeVoided)
	if !ok || vf != "1" || res != "0" {
		t.Fatalf("voided: %q %q %v", res, vf, ok)
	}
	if _, _, ok := settleFor(bifrost.OutcomeOpen); ok {
		t.Fatal("OPEN is not terminal")
	}
}

func TestRoundsFamilyScoreboard(t *testing.T) {
	m := sampleMatch(bifrost.MatchStarted)
	m.Tournament.Sport.ID = b64("sport/od:sport:3") // CS2
	m.SimpleScore.Periods = []bifrost.SimpleScorePeriod{{Number: 1, Home: "13", Away: "9"}, {Number: 2, Home: "7", Away: "8"}}
	body, err := OddsChange(m, 1)
	if err != nil {
		t.Fatal(err)
	}
	var got oddsChange
	if err := xml.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	rows := got.SportEventStatus.Periods.Rows
	if *rows[0].HomeWonRounds != 13 || *rows[0].AwayWonRounds != 9 || rows[0].HomeKills != nil {
		t.Fatalf("CS2 periods must carry rounds: %+v", rows[0])
	}
	if got.SportEventStatus.Scoreboard == nil || *got.SportEventStatus.Scoreboard.HomeWonRounds != 7 {
		t.Fatalf("live map must populate the scoreboard: %+v", got.SportEventStatus.Scoreboard)
	}
}

func TestNonNumericScoresAreOmitted(t *testing.T) {
	m := sampleMatch(bifrost.MatchStarted)
	m.SimpleScore.Home = "21/0 (1.0)" // eCricket shape
	m.SimpleScore.Away = "10/0 (0.3)*"
	m.SimpleScore.Periods = nil
	body, err := OddsChange(m, 1)
	if err != nil {
		t.Fatal(err)
	}
	var got oddsChange
	if err := xml.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if got.SportEventStatus.HomeScore != nil || got.SportEventStatus.Periods != nil {
		t.Fatalf("unparseable scores must be dropped, status kept: %+v", got.SportEventStatus)
	}
	if *got.SportEventStatus.Status != 1 {
		t.Fatal("lifecycle status must survive without a score")
	}
}

func TestProbabilitiesSingleRunnerAndBadOdds(t *testing.T) {
	one := []keyedOutcome{{id: "1", outcome: bifrost.Outcome{Odds: f(1.5), Status: bifrost.OutcomeOpen}}}
	if len(Probabilities(one)) != 0 {
		t.Fatal("a single quotable outcome has no meaningful probability")
	}
	mixed := []keyedOutcome{
		{id: "1", outcome: bifrost.Outcome{Odds: f(1.0), Status: bifrost.OutcomeOpen}},
		{id: "2", outcome: bifrost.Outcome{Odds: f(2.0), Status: bifrost.OutcomeOpen}},
		{id: "3", outcome: bifrost.Outcome{Odds: f(4.0), Status: bifrost.OutcomeWon}},
		{id: "4", outcome: bifrost.Outcome{Odds: f(4.0), Status: bifrost.OutcomeOpen}},
	}
	p := Probabilities(mixed)
	if _, has := p[0]; has {
		t.Fatal("odds of exactly 1.0 are not quotable")
	}
	if _, has := p[2]; has {
		t.Fatal("a settled outcome is not part of the book")
	}
	if p[1] != "0.6667" || p[3] != "0.3333" {
		t.Fatalf("normalisation: %+v", p)
	}
}

func TestFamilyForSport(t *testing.T) {
	if FamilyForSport("od:sport:3") != FamilyRounds || FamilyForSport("od:sport:2") != FamilyKills || FamilyForSport("od:sport:19") != FamilyGoals || FamilyForSport("od:sport:34") != FamilyGeneric {
		t.Fatal("sport family table drifted")
	}
}
