// Bifrost GraphQL wire shapes and id decoding.
//
// Bifrost is Oddin's white-label esports front end (the iframe behind
// maxbet.rs/en/esport). Every id it hands out is base64 of a slash-joined
// path whose second segment is an Oddin URN:
//
//	match/od:match:3139010
//	market/od:match:3139010/2/2-handicap=-1.5
//	outcome/od:match:3139010/2/2-handicap=-1.5/1
//	market_group/od:match:3139010/6|variant=way:two|map=2
//	team/od:competitor:1655   tournament/od:tournament:14611   sport/od:sport:2
//
// The market path is <group key>/<market_id>-<specifiers>, where the
// specifiers are already in Oddin's `k=v|k=v` form, so the pieces the
// rest of Oddzilla keys on — provider market id, specifier string, outcome
// id — fall straight out of the id. No lookup table is needed to map a
// Bifrost outcome onto a `market_outcomes` row.

package bifrost

import (
	"encoding/base64"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Match state values observed on the wire (2026-09-03 probe). There is no
// cancelled state: a cancelled event so far appears as CLOSED with every
// market removed. Tracked as an open gap in docs/BIFROST_BACKUP_FEED.md.
const (
	MatchNotStarted = "NOT_STARTED"
	MatchStarted    = "STARTED"
	MatchClosed     = "CLOSED"
)

// Market states.
const (
	MarketOpen      = "OPEN"
	MarketSuspended = "SUSPENDED"
	MarketClosed    = "CLOSED"
)

// Outcome statuses. INACTIVE is an outcome Bifrost stopped offering
// before settlement — never bettable, never resolved.
const (
	OutcomeOpen      = "OPEN"
	OutcomeSuspended = "SUSPENDED"
	OutcomeInactive  = "INACTIVE"
	OutcomeWon       = "WON"
	OutcomeLost      = "LOST"
	OutcomeHalfWon   = "HALF_WON"
	OutcomeHalfLost  = "HALF_LOST"
	OutcomeVoided    = "VOIDED"
)

type Match struct {
	ID               string        `json:"id"`
	DatePlannedStart string        `json:"datePlannedStart"`
	State            string        `json:"state"`
	PrematchOnly     bool          `json:"prematchOnly"`
	Categories       []string      `json:"categories"`
	Teams            []MatchTeam   `json:"teams"`
	Tournament       *Tournament   `json:"tournament"`
	MarketGroups     []MarketGroup `json:"marketGroups"`
	MainMarketGroups []MarketGroup `json:"mainMarketGroups"`
	SimpleScore      *SimpleScore  `json:"simpleScore"`
	AllStreams       []Stream      `json:"allStreams"`
	Stream           *Stream       `json:"stream"`
}

// URN returns the Oddin match URN encoded in the Bifrost id.
func (m Match) URN() string {
	_, path, err := DecodeID(m.ID)
	if err != nil || len(path) == 0 {
		return ""
	}
	return path[0]
}

type MatchTeam struct {
	Team   Team  `json:"team"`
	Winner *bool `json:"winner"`
}

type Team struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Icon string `json:"icon"`
}

// URN returns the Oddin competitor URN encoded in the Bifrost id.
func (t Team) URN() string { return urnOf(t.ID) }

type Tournament struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Sport *Sport `json:"sport"`
}

func (t Tournament) URN() string { return urnOf(t.ID) }

type Sport struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Icon string `json:"icon"`
}

func (s Sport) URN() string { return urnOf(s.ID) }

type MarketGroup struct {
	ID         string      `json:"id"`
	Name       string      `json:"name"`
	NamePrefix *string     `json:"namePrefix"`
	Category   string      `json:"category"`
	LayoutType string      `json:"layoutType"`
	Order      int         `json:"order"`
	Markets    []Market    `json:"markets"`
	Selections []Selection `json:"selections"`
}

type Selection struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Market struct {
	ID       string    `json:"id"`
	Info     *string   `json:"info"`
	State    string    `json:"state"`
	Outcomes []Outcome `json:"outcomes"`
}

type Outcome struct {
	ID     string   `json:"id"`
	Odds   *float64 `json:"odds"`
	Status string   `json:"status"`
}

type SimpleScore struct {
	Home            string              `json:"home"`
	Away            string              `json:"away"`
	PeriodType      string              `json:"periodType"`
	ActivePeriodIdx *int                `json:"activePeriodIdx"`
	TotalPeriods    int                 `json:"totalPeriods"`
	Periods         []SimpleScorePeriod `json:"periods"`
}

type SimpleScorePeriod struct {
	Number int    `json:"number"`
	Home   string `json:"home"`
	Away   string `json:"away"`
}

type Stream struct {
	URL            string `json:"url"`
	Locale         string `json:"locale"`
	Name           string `json:"name"`
	StreamProvider string `json:"streamProvider"`
}

// MatchStateChange is the payload of the onMatchStateChanged subscription.
type MatchStateChange struct {
	ID               string  `json:"id"`
	DatePlannedStart string  `json:"datePlannedStart"`
	State            string  `json:"state"`
	PrematchOnly     bool    `json:"prematchOnly"`
	Stream           *Stream `json:"stream"`
}

func (m MatchStateChange) URN() string { return urnOf(m.ID) }

// MarketKey is the (provider market id, canonical specifiers) pair every
// Oddzilla market row is keyed on, as recovered from a Bifrost market id.
type MarketKey struct {
	ProviderMarketID int
	// Specifiers is the canonical `k=v|k=v` string with keys sorted, the
	// same form packages/types/src/specifiers.ts hashes. Empty when the
	// market has no specifiers.
	Specifiers string
}

// DecodeID base64-decodes a Bifrost id into its kind and path segments.
// "bWF0Y2gvb2Q6bWF0Y2g6MzEzOTAxMA==" -> ("match", ["od:match:3139010"]).
func DecodeID(id string) (kind string, path []string, err error) {
	raw, err := base64.StdEncoding.DecodeString(id)
	if err != nil {
		// Some ids come unpadded.
		raw, err = base64.RawStdEncoding.DecodeString(id)
		if err != nil {
			return "", nil, fmt.Errorf("decode bifrost id %q: %w", id, err)
		}
	}
	parts := strings.Split(string(raw), "/")
	if len(parts) < 2 {
		return "", nil, fmt.Errorf("bifrost id %q has no path", id)
	}
	return parts[0], parts[1:], nil
}

// ParseMarketID recovers the market key from a Bifrost market id. The
// last path segment is `<market_id>-<specifiers>` (or just `<market_id>`
// for specifier-less markets); the group segment before it is ignored.
func ParseMarketID(id string) (urn string, key MarketKey, err error) {
	kind, path, err := DecodeID(id)
	if err != nil {
		return "", key, err
	}
	if kind != "market" || len(path) < 2 {
		return "", key, fmt.Errorf("not a market id: %q", id)
	}
	key, err = parseMarketSegment(path[len(path)-1])
	if err != nil {
		return "", key, fmt.Errorf("market id %q: %w", id, err)
	}
	return path[0], key, nil
}

// ParseOutcomeID recovers (match URN, market key, Oddin outcome id) from a
// Bifrost outcome id: outcome/<urn>/<group>/<market_id>-<specs>/<outcome>.
func ParseOutcomeID(id string) (urn string, key MarketKey, outcomeID string, err error) {
	kind, path, err := DecodeID(id)
	if err != nil {
		return "", key, "", err
	}
	if kind != "outcome" || len(path) < 3 {
		return "", key, "", fmt.Errorf("not an outcome id: %q", id)
	}
	key, err = parseMarketSegment(path[len(path)-2])
	if err != nil {
		return "", key, "", fmt.Errorf("outcome id %q: %w", id, err)
	}
	return path[0], key, path[len(path)-1], nil
}

func parseMarketSegment(seg string) (MarketKey, error) {
	idPart, specPart, _ := strings.Cut(seg, "-")
	mid, err := strconv.Atoi(idPart)
	if err != nil {
		return MarketKey{}, fmt.Errorf("market segment %q: bad market id", seg)
	}
	return MarketKey{ProviderMarketID: mid, Specifiers: CanonicalSpecifiers(specPart)}, nil
}

// CanonicalSpecifiers re-serialises a `k=v|k=v` string with keys sorted
// lexicographically — byte-identical to oddinxml.Canonical in the Go
// services and canonicalizeSpecifiers in packages/types. Bifrost already
// emits sorted keys, but the canonical form is what everything hashes,
// so we never rely on that.
func CanonicalSpecifiers(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	pairs := strings.Split(raw, "|")
	kv := make(map[string]string, len(pairs))
	keys := make([]string, 0, len(pairs))
	for _, p := range pairs {
		k, v, ok := strings.Cut(p, "=")
		k = strings.TrimSpace(k)
		if !ok || k == "" {
			continue
		}
		if _, dup := kv[k]; !dup {
			keys = append(keys, k)
		}
		kv[k] = strings.TrimSpace(v)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+kv[k])
	}
	return strings.Join(out, "|")
}

func urnOf(id string) string {
	_, path, err := DecodeID(id)
	if err != nil || len(path) == 0 {
		return ""
	}
	return path[0]
}
