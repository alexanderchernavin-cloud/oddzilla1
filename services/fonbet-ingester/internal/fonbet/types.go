// Wire types for the Fonbet public line API. Only the fields the
// ingester reads are declared; everything else in the (large) JSON is
// ignored by encoding/json. See docs/FONBET.md for the endpoint map and
// the observed payload shapes.

package fonbet

// ListResponse is GET <line>/events/list?lang=..&version=0&scopeMarket=..
type ListResponse struct {
	PacketVersion   int64            `json:"packetVersion"`
	Sports          []Sport          `json:"sports"`
	TournamentInfos []TournamentInfo `json:"tournamentInfos"`
	Events          []Event          `json:"events"`
	CustomFactors   []EventFactors   `json:"customFactors"`
	EventBlocks     []EventBlock     `json:"eventBlocks"`
	EventMiscs      []EventMisc      `json:"eventMiscs"`
	LiveEventInfos  []LiveEventInfo  `json:"liveEventInfos"`
}

// Sport is one node of the sports tree. kind="sport" without parentId is a
// root sport (Football, Tennis, ...); kind="segment" is a league /
// tournament whose parentId points at the root.
type Sport struct {
	ID    int    `json:"id"`
	Kind  string `json:"kind"`
	Name  string `json:"name"`
	Alias string `json:"alias"`
	// TournamentInfoID points into TournamentInfos, which is the SECOND
	// place Fonbet keeps a competition mark — see TournamentIcons.
	TournamentInfoID *int `json:"tournamentInfoId"`
	ParentID         *int `json:"parentId"`
}

// TournamentInfo is the per-competition metadata block riding on every
// events/list snapshot. Only Icon is read: it is an absolute-from-root
// CDN path ("/ContentCommon/Logotypes/Tournament/Football/england_pl.svg")
// drawn from a different asset tree than line/logos serves.
type TournamentInfo struct {
	ID   int    `json:"id"`
	Icon string `json:"icon"`
}

// Event: level 1 = match, level 2/3 = sub-event (half, map, corners,
// player props) with parentId pointing at the match.
type Event struct {
	ID        int64  `json:"id"`
	ParentID  int64  `json:"parentId"`
	Level     int    `json:"level"`
	SportID   int    `json:"sportId"` // segment id
	Kind      int64  `json:"kind"`
	Team1     string `json:"team1"`
	Team2     string `json:"team2"`
	Team1ID   int64  `json:"team1Id"`
	Team2ID   int64  `json:"team2Id"`
	Name      string `json:"name"`
	StartTime int64  `json:"startTime"` // unix seconds
	Place     string `json:"place"`     // line | live | notActive
}

// EventFactors carries the odds for one event.
type EventFactors struct {
	EventID int64    `json:"e"`
	Factors []Factor `json:"factors"`
}

// Factor is one priced outcome. P is the raw parameter (x100), PT its
// display string ("-2.5", "+2.5", "2.5"). Both absent for plain markets.
type Factor struct {
	F  int     `json:"f"`
	V  float64 `json:"v"`
	P  *int    `json:"p"`
	PT string  `json:"pt"`
}

// EventBlock: state="blocked" suspends the whole event, "partial" lists
// the suspended factor ids.
type EventBlock struct {
	EventID int64  `json:"eventId"`
	State   string `json:"state"`
	Factors []int  `json:"factors"`
}

// EventMisc carries the compact live score.
//
// The three timer fields are Fonbet's clock MODEL, as opposed to the
// rendered `timer` string on LiveEventInfo: TimerSeconds is what the
// clock read at TimerUpdateTimestampMsec, and TimerDirection says how it
// has moved since (1 = counting up, 0 = stopped, -1 = counting down).
// Measured on a live fon.bet snapshot (2026-09-07): a running football
// half arrives as {timerSeconds: 0, timerDirection: 1,
// timerUpdateTimestampMsec: <kick-off>} and stays byte-identical for the
// whole half; half time is {timerSeconds: 2700, timerDirection: 0} with
// no timestamp. That is the shape a storefront can run a clock from
// between polls, which the display string is not.
type EventMisc struct {
	ID                       int64  `json:"id"`
	Score1                   *int   `json:"score1"`
	Score2                   *int   `json:"score2"`
	Comment                  string `json:"comment"`
	TimerSeconds             *int   `json:"timerSeconds"`
	TimerDirection           *int   `json:"timerDirection"`
	TimerUpdateTimestampMsec *int64 `json:"timerUpdateTimestampMsec"`
}

// LiveEventInfo carries the detailed live scoreboard.
//
// Its timer triple is the same model as EventMisc's, restated at the
// packet's own time: TimerSeconds is the clock reading at
// TimerTimestampMsec (which is the snapshot generation time, shared by
// every row in the packet). Preferred over the EventMisc anchor because
// it is always fresh — a Fonbet-side clock correction shows up here on
// the next poll — while the two agree to within the integer second
// whenever the clock has run undisturbed.
type LiveEventInfo struct {
	EventID            int64         `json:"eventId"`
	Finished           bool          `json:"finished"`
	Timer              string        `json:"timer"`
	TimerSeconds       *int          `json:"timerSeconds"`
	TimerDirection     *int          `json:"timerDirection"`
	TimerTimestampMsec *int64        `json:"timerTimestampMsec"`
	Scores             [][]ScoreCell `json:"scores"`
	ScoreComment       string        `json:"scoreComment"`
}

type ScoreCell struct {
	C1    string `json:"c1"`
	C2    string `json:"c2"`
	Title string `json:"title"`
	// Serve marks the side holding serve on this cell: 1 = c1, 2 = c2,
	// absent everywhere else. Sent on the innermost cell only — the
	// current game for tennis (title "game"), the current set for table
	// tennis and volleyball (title "set") — and mirrored as an asterisk
	// in scoreComment / the subscore comment ("7*-10" = c1 serving).
	Serve *int `json:"serve"`
}

// Catalog is GET <line>/line/factorsCatalog/tables?version=0&lang=..&sysId=..
type Catalog struct {
	Lang   string  `json:"lang"`
	Groups []Group `json:"groups"`
}

type Group struct {
	Name   string  `json:"name"`
	Tables []Table `json:"tables"`
}

// Table is one market layout. Rows[0] is usually the header (column
// captions); later rows hold cells that are either text labels, "param"
// cells (the line value) or "value" cells (the priced factor).
type Table struct {
	Num    int      `json:"num"`
	Name   string   `json:"name"`
	IsMain bool     `json:"isMain"`
	Rows   [][]Cell `json:"rows"`
}

type Cell struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"` // "" (text) | "param" | "value"
	FactorID int    `json:"factorId"`
}
