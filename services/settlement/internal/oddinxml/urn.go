package oddinxml

import (
	"fmt"
	"strconv"
	"strings"
)

// URN parses Oddin identifiers like "od:sport:5", "od:tournament:123",
// "od:match:100234", "od:competitor:1", "od:player:99".
//
// The "type" segment is stored verbatim so dynamic outcomes
// (`od:dynamic_outcomes:27|v1`) can round-trip — we don't try to interpret
// those in MVP scope.
type URN struct {
	Scheme string // always "od" from Oddin
	Type   string // "sport", "tournament", "match", "competitor", "player", ...
	ID     string // numeric id or composite (e.g. "27|v1")
}

// ParseURN parses "od:type:id" (tolerates leading/trailing whitespace).
// Returns an error if the URN doesn't have exactly three colon-separated
// segments with a non-empty id.
func ParseURN(raw string) (URN, error) {
	s := strings.TrimSpace(raw)
	parts := strings.SplitN(s, ":", 3)
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return URN{}, fmt.Errorf("urn: invalid shape %q", raw)
	}
	return URN{Scheme: parts[0], Type: parts[1], ID: parts[2]}, nil
}

func (u URN) String() string {
	return u.Scheme + ":" + u.Type + ":" + u.ID
}

// IntID returns the integer form of the id segment. Fails for composite ids
// (dynamic outcomes).
func (u URN) IntID() (int64, error) {
	n, err := strconv.ParseInt(u.ID, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("urn %q: id is not numeric: %w", u.String(), err)
	}
	return n, nil
}
