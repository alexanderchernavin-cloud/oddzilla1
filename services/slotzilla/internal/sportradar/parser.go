// Parser for Sportradar's gismo timeline documents. Both endpoints the
// service reads share one envelope:
//
//	{"queryUrl": "...", "doc": [{"event": "match_timeline", "_dob": <unix s>,
//	  "_maxage": N, "data": {"match": {...}, "events": [...]}}]}
//
// An error is an HTTP 200 whose doc[0].event is "exception" with
// data.message. Numbers the feed sends as strings (timeinfo.played is
// "2072") and fields that are `false` when absent (ended_uts) are read
// through flexible scalar types rather than trusted to one shape.

package sportradar

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/oddzilla/slotzilla/internal/rules"
)

// BasketballSportID is Sportradar's _sid for basketball.
const BasketballSportID = 2

// ExceptionError is the feed's in-band error document.
type ExceptionError struct {
	Query   string
	Message string
	Name    string
	Code    int
}

func (e *ExceptionError) Error() string {
	return fmt.Sprintf("sportradar exception on %s: %s (%s %d)", e.Query, e.Message, e.Name, e.Code)
}

// FlexInt reads a JSON number, a numeric string, null or false. Valid is
// false for null / false / an unparseable string, so "no reading" is
// distinguishable from 0.
type FlexInt struct {
	Value int64
	Valid bool
}

func (f *FlexInt) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	f.Value, f.Valid = 0, false
	switch {
	case s == "null" || s == "false" || s == `""`:
		return nil
	case s == "true":
		f.Value, f.Valid = 1, true
		return nil
	case strings.HasPrefix(s, `"`):
		var str string
		if err := json.Unmarshal(b, &str); err != nil {
			return err
		}
		n, err := strconv.ParseInt(strings.TrimSpace(str), 10, 64)
		if err != nil {
			return nil
		}
		f.Value, f.Valid = n, true
		return nil
	default:
		var fl float64
		if err := json.Unmarshal(b, &fl); err != nil {
			return err
		}
		f.Value, f.Valid = int64(fl), true
		return nil
	}
}

// FlexBool reads a JSON bool or a 0 / 1 number.
type FlexBool bool

func (f *FlexBool) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	switch s {
	case "true", "1":
		*f = true
	case "false", "0", "null":
		*f = false
	default:
		var n float64
		if err := json.Unmarshal(b, &n); err != nil {
			return fmt.Errorf("flexbool %q: %w", s, err)
		}
		*f = n != 0
	}
	return nil
}

// Envelope is the outer document.
type Envelope struct {
	QueryURL string `json:"queryUrl"`
	Doc      []Doc  `json:"doc"`
}

// Doc is one entry of the envelope's doc array.
type Doc struct {
	Event  string          `json:"event"`
	DOB    int64           `json:"_dob"`
	MaxAge int             `json:"_maxage"`
	Data   json.RawMessage `json:"data"`
}

// Player is the scorer / player block on an event (coverage Level 2).
type Player struct {
	ID   int64  `json:"_id"`
	Name string `json:"name"`
}

// Event is one timeline event. Raw keeps the whole object for the
// sr_live_events.raw column.
type Event struct {
	ID         int64    `json:"_id"`
	Type       string   `json:"type"`
	Name       string   `json:"name"`
	UTS        int64    `json:"uts"`
	UpdatedUTS int64    `json:"updated_uts"`
	Seconds    int      `json:"seconds"`
	Time       int      `json:"time"`
	Team       string   `json:"team"`
	Points     *int     `json:"points"`
	Disabled   FlexBool `json:"disabled"`
	Period     *int     `json:"period"`
	Scorer     *Player  `json:"scorer"`
	Player     *Player  `json:"player"`
	Raw        json.RawMessage
}

// TimeInfo is the match clock block.
type TimeInfo struct {
	Played    FlexInt `json:"played"`
	Remaining FlexInt `json:"remaining"`
	Running   bool    `json:"running"`
	Started   FlexInt `json:"started"`
	Ended     FlexInt `json:"ended"`
}

// Match is the fixture block of a timeline document.
type Match struct {
	ID      int64 `json:"_id"`
	SportID int   `json:"_sid"`
	Teams   struct {
		Home struct {
			Name string `json:"name"`
		} `json:"home"`
		Away struct {
			Name string `json:"name"`
		} `json:"away"`
	} `json:"teams"`
	Result struct {
		Home *int `json:"home"`
		Away *int `json:"away"`
	} `json:"result"`
	Period   FlexInt  `json:"p"`
	TimeInfo TimeInfo `json:"timeinfo"`
	Coverage struct {
		Live struct {
			Level struct {
				Value *int `json:"value"`
			} `json:"level"`
		} `json:"live"`
	} `json:"coverage"`
	Status struct {
		Name string `json:"name"`
	} `json:"status"`
	EndedUTS   FlexInt `json:"ended_uts"`
	UpdatedUTS int64   `json:"updated_uts"`
	Cancelled  bool    `json:"cancelled"`
	Postponed  bool    `json:"postponed"`
}

// Clock is the reading the engine and the storefront work from.
type Clock struct {
	// Seconds is the cumulative match-clock reading.
	Seconds int
	// Running is the feed's flag, forced false once the match has ended
	// (the feed leaves it true on an ended fixture).
	Running bool
	// Period is nil before tip-off and after the end (the feed sends "0").
	Period  *int
	Started bool
	Ended   bool
}

// Clock derives the clock reading from the match block.
func (m *Match) Clock() Clock {
	c := Clock{
		Seconds: int(m.TimeInfo.Played.Value),
		Started: m.HasStarted(),
		Ended:   m.IsEnded(),
	}
	c.Running = m.TimeInfo.Running && !c.Ended
	if m.Period.Valid && m.Period.Value > 0 {
		p := int(m.Period.Value)
		c.Period = &p
	}
	return c
}

// HasStarted reports whether the match has tipped off: timeinfo.started
// set, or a clock reading above zero.
func (m *Match) HasStarted() bool {
	if m.TimeInfo.Started.Valid && m.TimeInfo.Started.Value > 0 {
		return true
	}
	return m.TimeInfo.Played.Valid && m.TimeInfo.Played.Value > 0
}

// IsEnded reports whether the match is over: timeinfo.ended or ended_uts
// set, or the status block reading "Ended".
func (m *Match) IsEnded() bool {
	if m.TimeInfo.Ended.Valid && m.TimeInfo.Ended.Value > 0 {
		return true
	}
	if m.EndedUTS.Valid && m.EndedUTS.Value > 0 {
		return true
	}
	return strings.EqualFold(m.Status.Name, "Ended")
}

// CoverageLevel returns coverage.live.level.value (2 = players on events;
// 3 / 5 = team-only), nil when absent.
func (m *Match) CoverageLevel() *int {
	return m.Coverage.Live.Level.Value
}

// Timeline is a parsed match_timeline or match_timelinedelta document.
type Timeline struct {
	Query  string
	Kind   string
	DOB    int64
	MaxAge int
	Match  Match
	Events []Event
}

// FeedLag returns how far behind `now` the document was built.
func (t *Timeline) FeedLag(now time.Time) time.Duration {
	if t.DOB <= 0 {
		return 0
	}
	return now.Sub(time.Unix(t.DOB, 0))
}

// Parse decodes one timeline document. An exception document is returned
// as *ExceptionError.
func Parse(body []byte) (*Timeline, error) {
	// A byte-order mark is not JSON; tolerate one rather than fail a
	// document that is otherwise fine.
	body = bytes.TrimPrefix(body, []byte("\xef\xbb\xbf"))
	var env Envelope
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, fmt.Errorf("decode envelope: %w", err)
	}
	if len(env.Doc) == 0 {
		return nil, fmt.Errorf("envelope for %q carries no doc", env.QueryURL)
	}
	doc := env.Doc[0]
	if doc.Event == "exception" {
		var ex struct {
			Message string `json:"message"`
			Code    int    `json:"code"`
			Name    string `json:"name"`
			Query   string `json:"query"`
		}
		if err := json.Unmarshal(doc.Data, &ex); err != nil {
			return nil, fmt.Errorf("decode exception for %q: %w", env.QueryURL, err)
		}
		return nil, &ExceptionError{Query: env.QueryURL, Message: ex.Message, Name: ex.Name, Code: ex.Code}
	}
	var data struct {
		Match  Match             `json:"match"`
		Events []json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(doc.Data, &data); err != nil {
		return nil, fmt.Errorf("decode %s data: %w", doc.Event, err)
	}
	if data.Match.ID == 0 {
		return nil, fmt.Errorf("%s for %q carries no match", doc.Event, env.QueryURL)
	}
	t := &Timeline{Query: env.QueryURL, Kind: doc.Event, DOB: doc.DOB, MaxAge: doc.MaxAge, Match: data.Match}
	t.Events = make([]Event, 0, len(data.Events))
	for i, raw := range data.Events {
		var e Event
		if err := json.Unmarshal(raw, &e); err != nil {
			return nil, fmt.Errorf("decode event %d: %w", i, err)
		}
		if e.ID == 0 {
			continue
		}
		var compact bytes.Buffer
		if err := json.Compact(&compact, raw); err != nil {
			return nil, fmt.Errorf("compact event %d: %w", i, err)
		}
		e.Raw = json.RawMessage(compact.Bytes())
		t.Events = append(t.Events, e)
	}
	return t, nil
}

// EventRow is what the store writes for one event: the feed's fields
// plus the symbol derived ONCE by the shared rule.
type EventRow struct {
	SrEventID  int64
	SrMatchID  int64
	Type       string
	Symbol     string // "" = no symbol (NULL)
	Team       string // "home" | "away" | "" (NULL)
	Points     *int
	Seconds    int
	UTS        int64
	UpdatedUTS int64
	Disabled   bool
	Period     *int
	PlayerID   *int64
	PlayerName string
	Raw        []byte
}

// Rows derives the storable rows from a timeline, skipping events with
// no clock reading (seconds < 0: warm-ups, lineups, the timeinfo block).
func (t *Timeline) Rows() []EventRow {
	out := make([]EventRow, 0, len(t.Events))
	for i := range t.Events {
		e := &t.Events[i]
		if e.Seconds < 0 {
			continue
		}
		row := EventRow{
			SrEventID:  e.ID,
			SrMatchID:  t.Match.ID,
			Type:       e.Type,
			Points:     e.Points,
			Seconds:    e.Seconds,
			UTS:        e.UTS,
			UpdatedUTS: e.UpdatedUTS,
			Disabled:   bool(e.Disabled),
			Period:     e.Period,
			Raw:        e.Raw,
		}
		if row.UpdatedUTS == 0 {
			row.UpdatedUTS = row.UTS
		}
		if sym, ok := rules.SymbolForEvent(e.Type, e.Points); ok {
			row.Symbol = string(sym)
		}
		if e.Team == "home" || e.Team == "away" {
			row.Team = e.Team
		}
		if p := firstPlayer(e.Scorer, e.Player); p != nil {
			id := p.ID
			row.PlayerID = &id
			row.PlayerName = p.Name
		}
		out = append(out, row)
	}
	return out
}

func firstPlayer(ps ...*Player) *Player {
	for _, p := range ps {
		if p != nil && p.ID != 0 {
			return p
		}
	}
	return nil
}
