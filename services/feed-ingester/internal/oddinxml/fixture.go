// Decoders for Oddin REST responses we use during auto-mapping.
//
// /v1/sports/{lang}/sport_events/{matchURN}/fixture
//   <fixtures_fixture><fixture id="..." name="..." scheduled="..." start_time="..." status="live">
//     <tournament id="od:tournament:13012" name="..." abbreviation="...">
//       <sport id="od:sport:19" name="eFootball" abbreviation="eFootball"/>
//     </tournament>
//     <competitors>
//       <competitor id="od:competitor:..." name="..." qualifier="home"/>
//       <competitor id="od:competitor:..." name="..." qualifier="away"/>
//     </competitors>
//     <extra_info>
//       <info key="best_of" value="1"/>
//     </extra_info>
//   </fixture></fixtures_fixture>
//
// /v1/sports/{lang}/sports
//   <sports><sport id="od:sport:N" name="..." abbreviation="..."/></sports>

package oddinxml

import "encoding/xml"

// FixtureResponse is the top-level wrapper of /sport_events/.../fixture.
type FixtureResponse struct {
	XMLName xml.Name        `xml:"fixtures_fixture"`
	Fixture FixturePayload  `xml:"fixture"`
}

type FixturePayload struct {
	ID          string                 `xml:"id,attr"`
	Name        string                 `xml:"name,attr"`
	Scheduled   string                 `xml:"scheduled,attr"`
	StartTime   string                 `xml:"start_time,attr"`
	Status      string                 `xml:"status,attr"`
	Tournament  FixtureTournament      `xml:"tournament"`
	Competitors FixtureCompetitorsList `xml:"competitors"`
	ExtraInfo   FixtureExtraInfoList   `xml:"extra_info"`
}

type FixtureTournament struct {
	ID    string       `xml:"id,attr"`
	Name  string       `xml:"name,attr"`
	Abbr  string       `xml:"abbreviation,attr"`
	Sport FixtureSport `xml:"sport"`
}

type FixtureSport struct {
	ID   string `xml:"id,attr"`
	Name string `xml:"name,attr"`
	Abbr string `xml:"abbreviation,attr"`
}

type FixtureCompetitorsList struct {
	Competitors []FixtureCompetitor `xml:"competitor"`
}

type FixtureCompetitor struct {
	ID        string `xml:"id,attr"`
	Name      string `xml:"name,attr"`
	Qualifier string `xml:"qualifier,attr"` // "home" | "away"
}

type FixtureExtraInfoList struct {
	Items []FixtureExtraInfo `xml:"info"`
}

type FixtureExtraInfo struct {
	Key   string `xml:"key,attr"`
	Value string `xml:"value,attr"`
}

// TournamentInfoResponse wraps /v1/sports/{lang}/tournaments/{urn}/info.
// The tournament element carries the risk_tier attribute (1..N) that
// tells the sidebar how to prioritise tournaments when a sport has many.
type TournamentInfoResponse struct {
	XMLName    xml.Name           `xml:"tournament_info"`
	Tournament TournamentInfoItem `xml:"tournament"`
}

type TournamentInfoItem struct {
	ID       string `xml:"id,attr"`
	Name     string `xml:"name,attr"`
	RiskTier string `xml:"risk_tier,attr"`
}

// SportsResponse is the top-level wrapper of /sports.
type SportsResponse struct {
	XMLName xml.Name      `xml:"sports"`
	Sports  []SportEntry  `xml:"sport"`
}

type SportEntry struct {
	ID   string `xml:"id,attr"`
	Name string `xml:"name,attr"`
	Abbr string `xml:"abbreviation,attr"`
}

// ErrorResponse is what Oddin returns on 4xx — useful for "Tournament not
// found" / "Sport event not found" detection without parsing every endpoint
// response twice.
type ErrorResponse struct {
	XMLName      xml.Name `xml:"response"`
	ResponseCode string   `xml:"response_code,attr"`
	Action       string   `xml:"action"`
	Message      string   `xml:"message"`
}
