// Oddin competitor profile XML shape. Returned by
//   GET /v1/sports/{lang}/competitors/{urn}/profile
//
// Example (elided):
//
//   <competitor_profile>
//     <competitor id="od:competitor:12528" name="Movistar KOI" abbreviation="Movistar KOI" icon_path="…">
//       <sport id="od:sport:1" name="League of Legends" abbreviation="LoL"/>
//     </competitor>
//     <players>
//       <player id="od:player:10705" name="Myrwn" full_name="Alex Villarejo" sport="od:sport:1"/>
//       ...
//     </players>
//   </competitor_profile>
//
// A team can map to multiple sports (shared organization across titles);
// we only care about the first sport for populating player_profiles.sport_urn.

package oddinxml

import "encoding/xml"

type CompetitorProfile struct {
	XMLName    xml.Name          `xml:"competitor_profile"`
	Competitor CompetitorEntry   `xml:"competitor"`
	Players    []ProfilePlayer   `xml:"players>player"`
}

type CompetitorEntry struct {
	ID           string          `xml:"id,attr"`
	Name         string          `xml:"name,attr"`
	Abbreviation string          `xml:"abbreviation,attr"`
	IconPath     string          `xml:"icon_path,attr"`
	Sports       []CompetitorSport `xml:"sport"`
}

type CompetitorSport struct {
	ID           string `xml:"id,attr"`
	Name         string `xml:"name,attr"`
	Abbreviation string `xml:"abbreviation,attr"`
}

type ProfilePlayer struct {
	ID       string `xml:"id,attr"`
	Name     string `xml:"name,attr"`
	FullName string `xml:"full_name,attr"`
	Sport    string `xml:"sport,attr"`
}
