// Static Fonbet root-sport table: stable slugs + English display names.
// Fonbet's own `alias` field is only set for a handful of sports and the
// feed names arrive in the request language, so slugs are pinned here
// (sports.slug is UNIQUE and drives the storefront URLs). Unknown roots
// fall back to `fb-<id>` + the feed name.

package mapper

// EsportsRootID is Fonbet's "Киберспорт" root. Blocked by default in
// config because Oddin already supplies the esports vertical.
const EsportsRootID = 29086

type SportInfo struct {
	Slug string
	Name string
	Kind string // sport_kind enum: "traditional" | "esport"
}

var knownSports = map[int]SportInfo{
	1:     {"football", "Football", "traditional"},
	2:     {"ice-hockey", "Ice Hockey", "traditional"},
	3:     {"basketball", "Basketball", "traditional"},
	4:     {"tennis", "Tennis", "traditional"},
	5:     {"baseball", "Baseball", "traditional"},
	6:     {"american-football", "American Football", "traditional"},
	7:     {"motorsport", "Motorsport", "traditional"},
	8:     {"handball", "Handball", "traditional"},
	9:     {"volleyball", "Volleyball", "traditional"},
	10:    {"bandy", "Bandy", "traditional"},
	16:    {"rugby", "Rugby", "traditional"},
	17591: {"padel", "Padel", "traditional"},
	1219:  {"water-polo", "Water Polo", "traditional"},
	1429:  {"billiards", "Billiards", "traditional"},
	1434:  {"futsal", "Futsal", "traditional"},
	1436:  {"boxing", "Boxing", "traditional"},
	1437:  {"chess", "Chess", "traditional"},
	1891:  {"cycling", "Cycling", "traditional"},
	3088:  {"table-tennis", "Table Tennis", "traditional"},
	11624: {"beach-volleyball", "Beach Volleyball", "traditional"},
	11625: {"beach-soccer", "Beach Soccer", "traditional"},
	11627: {"floorball", "Floorball", "traditional"},
	11629: {"lacrosse", "Lacrosse", "traditional"},
	11630: {"badminton", "Badminton", "traditional"},
	11632: {"darts", "Darts", "traditional"},
	11634: {"cricket", "Cricket", "traditional"},
	11638: {"aussie-rules", "Australian Football", "traditional"},
	11639: {"gaelic-sports", "Gaelic Sports", "traditional"},
	29086: {"fonbet-esports", "Esports (Fonbet)", "esport"},
	37145: {"mma", "Martial Arts", "traditional"},
	45949: {"specials", "Specials", "traditional"},
	47041: {"basketball-3x3", "Basketball 3x3", "traditional"},
}

// SportFor returns the static info for a Fonbet root sport, synthesising
// a slug + name for unknown ids.
func SportFor(rootID int, feedName string) SportInfo {
	if s, ok := knownSports[rootID]; ok {
		return s
	}
	name := feedName
	if name == "" {
		name = "Sport " + itoa(rootID)
	}
	return SportInfo{Slug: "fb-" + itoa(rootID), Name: name, Kind: "traditional"}
}
