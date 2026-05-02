// Oddin AMQP message structs. Decoded with encoding/xml.
//
// The on-wire shapes are documented in Oddin's "Odds Feed API documentation"
// (see docs/ODDIN.md). These mirror the message types we actually consume.
// Unknown attributes/elements are ignored by encoding/xml so forward-compat
// is automatic — new Oddin fields don't break the decoder.

package oddinxml

import (
	"bytes"
	"encoding/xml"
	"fmt"
)

// ─── OddsChange ────────────────────────────────────────────────────────────

// OddsChange arrives on topic keys like `*.*.*.odds_change.#`.
type OddsChange struct {
	XMLName   xml.Name `xml:"odds_change"`
	EventID   string   `xml:"event_id,attr"`   // "od:match:123"
	Product   int      `xml:"product,attr"`    // 1 pre-match, 2 live
	Timestamp int64    `xml:"timestamp,attr"`  // ms since epoch
	Request   *int64   `xml:"request_id,attr"` // set on snapshot recovery

	SportEventStatus *SportEventStatus `xml:"sport_event_status"`
	Odds             *OddsBlock        `xml:"odds"`
}

// SportEventStatus is the live scoreboard block carried inside odds_change
// (and inside REST /v1/sports/en/sport_events/{urn}/summary). Shape mirrors
// Sportradar UOF's sportEventStatus type — Oddin keeps the same XSD.
//
// `home_score`/`away_score` are the series score (number of maps won, etc.).
// Per-map detail lives in <period_scores>; the live state of the current
// map lives in <scoreboard>. Both children are optional and absent on
// pre-match snapshots.
type SportEventStatus struct {
	Status              *int          `xml:"status,attr"`              // 0..9 lifecycle code
	MatchStatus         *int          `xml:"match_status,attr"`        // sport-specific in-game phase (live=6, ended=100, …)
	HomeScore           *int          `xml:"home_score,attr"`          // series score (maps won)
	AwayScore           *int          `xml:"away_score,attr"`
	ScoreboardAvailable string        `xml:"scoreboard_available,attr"`
	PeriodScores        *PeriodScores `xml:"period_scores"`
	Scoreboard          *Scoreboard   `xml:"scoreboard"`
}

type PeriodScores struct {
	Periods []PeriodScore `xml:"period_score"`
}

// PeriodScore is one row inside <period_scores>. For CS2/Valorant `type` is
// "map" and `home_won_rounds`/`away_won_rounds` carry the per-map round
// score; for Dota 2 / LoL `home_kills` / `away_kills` carry the per-map
// kill count. Generic `home_score`/`away_score` is the headline per-map
// number (rounds for CS2, kills for Dota, goals for football, etc.).
type PeriodScore struct {
	Number               *int   `xml:"number,attr"`
	Type                 string `xml:"type,attr"`
	MatchStatusCode      *int   `xml:"match_status_code,attr"`
	HomeScore            *int   `xml:"home_score,attr"`
	AwayScore            *int   `xml:"away_score,attr"`
	HomeWonRounds        *int   `xml:"home_won_rounds,attr"`
	AwayWonRounds        *int   `xml:"away_won_rounds,attr"`
	HomeKills            *int   `xml:"home_kills,attr"`
	AwayKills            *int   `xml:"away_kills,attr"`
	HomeGoals            *int   `xml:"home_goals,attr"`
	AwayGoals            *int   `xml:"away_goals,attr"`
	HomeDestroyedTurrets *int   `xml:"home_destroyed_turrets,attr"`
	AwayDestroyedTurrets *int   `xml:"away_destroyed_turrets,attr"`
	HomeDestroyedTowers  *int   `xml:"home_destroyed_towers,attr"`
	AwayDestroyedTowers  *int   `xml:"away_destroyed_towers,attr"`
}

// Scoreboard is the live state of the current period (map). Field names
// reflect the union of attributes Oddin emits across our supported
// esports — only the ones relevant to the current sport are populated.
type Scoreboard struct {
	CurrentCtTeam        *int   `xml:"current_ct_team,attr"`
	CurrentDefTeam       *int   `xml:"current_def_team,attr"`
	HomeWonRounds        *int   `xml:"home_won_rounds,attr"`
	AwayWonRounds        *int   `xml:"away_won_rounds,attr"`
	HomeKills            *int   `xml:"home_kills,attr"`
	AwayKills            *int   `xml:"away_kills,attr"`
	HomeDestroyedTurrets *int   `xml:"home_destroyed_turrets,attr"`
	AwayDestroyedTurrets *int   `xml:"away_destroyed_turrets,attr"`
	HomeDestroyedTowers  *int   `xml:"home_destroyed_towers,attr"`
	AwayDestroyedTowers  *int   `xml:"away_destroyed_towers,attr"`
	HomeGold             *int   `xml:"home_gold,attr"`
	AwayGold             *int   `xml:"away_gold,attr"`
	HomeGoals            *int   `xml:"home_goals,attr"`
	AwayGoals            *int   `xml:"away_goals,attr"`
	Time                 string `xml:"time,attr"`
	GameTime             *int   `xml:"game_time,attr"`
	RemainingGameTime    *int   `xml:"remaining_game_time,attr"`
}

type OddsBlock struct {
	Markets []Market `xml:"market"`
}

// Market status codes (from Oddin):
//  1  active (accepting bets)
//  0  inactive (hide, no bets)
// -1  suspended (no bets for up to ~60s)
// -2  handed over (pre-match → live transition)
// -3  settled  (only in bet_settlement)
// -4  cancelled (only in bet_cancel)
type Market struct {
	ID                 int       `xml:"id,attr"`
	Specifiers         string    `xml:"specifiers,attr"`
	ExtendedSpecifiers string    `xml:"extended_specifiers,attr"`
	Status             int       `xml:"status,attr"`
	VoidReasonID       *int      `xml:"void_reason_id,attr"`
	VoidReasonParams   string    `xml:"void_reason_params,attr"`
	StartTime          *int64    `xml:"start_time,attr"` // bet_cancel window (ms)
	EndTime            *int64    `xml:"end_time,attr"`
	FavouriteIsHome    string    `xml:"favourite,attr"`
	Outcomes           []Outcome `xml:"outcome"`
}

type Outcome struct {
	ID           string `xml:"id,attr"`           // "1", "2", or a URN
	Odds         string `xml:"odds,attr"`         // decimal string
	Active       *int   `xml:"active,attr"`       // 1 yes, 0 no
	Probability  string `xml:"probabilities,attr"`
	Result       string `xml:"result,attr"`       // bet_settlement: "1" won, "0" lost
	VoidFactor   string `xml:"void_factor,attr"`  // "0.5" half, "1.0" full void
	Name         string `xml:"name,attr"`
}

// ─── BetSettlement ─────────────────────────────────────────────────────────

type BetSettlement struct {
	XMLName   xml.Name `xml:"bet_settlement"`
	EventID   string   `xml:"event_id,attr"`
	Product   int      `xml:"product,attr"`
	Timestamp int64    `xml:"timestamp,attr"`
	Certainty int      `xml:"certainty,attr"` // 1 live-confirmed, 2 post-game

	Outcomes *SettlementMarkets `xml:"outcomes"`
}

type SettlementMarkets struct {
	Markets []Market `xml:"market"`
}

// ─── BetCancel ─────────────────────────────────────────────────────────────

type BetCancel struct {
	XMLName   xml.Name `xml:"bet_cancel"`
	EventID   string   `xml:"event_id,attr"`
	Product   int      `xml:"product,attr"`
	Timestamp int64    `xml:"timestamp,attr"`

	Markets []Market `xml:"market"`
}

// ─── BetStop ───────────────────────────────────────────────────────────────

// BetStop suspends markets in a group across an entire event (or a subset).
type BetStop struct {
	XMLName     xml.Name `xml:"bet_stop"`
	EventID     string   `xml:"event_id,attr"`
	Product     int      `xml:"product,attr"`
	Timestamp   int64    `xml:"timestamp,attr"`
	Groups      string   `xml:"groups,attr"`       // comma-separated names ("all" or specifics)
	MarketStatus int     `xml:"market_status,attr"` // status to transition to (typically -1)
}

// ─── FixtureChange ─────────────────────────────────────────────────────────

type FixtureChange struct {
	XMLName    xml.Name `xml:"fixture_change"`
	EventID    string   `xml:"event_id,attr"`
	Product    int      `xml:"product,attr"`
	Timestamp  int64    `xml:"timestamp,attr"`
	ChangeType string   `xml:"change_type,attr"` // "new", "datetime", "cancelled", ...
	StartTime  *int64   `xml:"start_time,attr"`
	NextLiveAt *int64   `xml:"next_live_time,attr"`
}

// ─── MatchStatusChange ─────────────────────────────────────────────────────

// MatchStatusChange announces a transition in the match's lifecycle status
// (not_started → live → ended → closed → cancelled). Oddin's protocol
// follows the Sportradar UOF convention; the `status` attribute is a
// numeric code documented at GET /v1/descriptions/en/match_status. We've
// observed that the integration broker emits these only sparsely (many
// matches end without one ever arriving — see the phantom-drain
// background worker), so this handler is a best-effort fast path; the
// REST-driven drain is the authoritative cleanup.
type MatchStatusChange struct {
	XMLName   xml.Name `xml:"match_status_change"`
	EventID   string   `xml:"event_id,attr"`
	Product   int      `xml:"product,attr"`
	Timestamp int64    `xml:"timestamp,attr"`
	RequestID *int64   `xml:"request_id,attr"` // set on snapshot recovery
	Status    int      `xml:"status,attr"`     // see MapMatchStatusCode
}

// ─── Rollbacks ─────────────────────────────────────────────────────────────

type RollbackBetSettlement struct {
	XMLName   xml.Name `xml:"rollback_bet_settlement"`
	EventID   string   `xml:"event_id,attr"`
	Product   int      `xml:"product,attr"`
	Timestamp int64    `xml:"timestamp,attr"`

	Markets []Market `xml:"market"`
}

type RollbackBetCancel struct {
	XMLName   xml.Name `xml:"rollback_bet_cancel"`
	EventID   string   `xml:"event_id,attr"`
	Product   int      `xml:"product,attr"`
	Timestamp int64    `xml:"timestamp,attr"`

	Markets []Market `xml:"market"`
}

// ─── Alive + SnapshotComplete ──────────────────────────────────────────────

type Alive struct {
	XMLName    xml.Name `xml:"alive"`
	Product    int      `xml:"product,attr"`
	Timestamp  int64    `xml:"timestamp,attr"`
	Subscribed int      `xml:"subscribed,attr"` // 1 = we're in sync
}

type SnapshotComplete struct {
	XMLName   xml.Name `xml:"snapshot_complete"`
	Product   int      `xml:"product,attr"`
	Timestamp int64    `xml:"timestamp,attr"`
	RequestID int64    `xml:"request_id,attr"`
}

// ─── Union type for dispatch ───────────────────────────────────────────────

// MessageKind identifies the top-level element seen by a raw sniffer.
type MessageKind int

const (
	KindUnknown MessageKind = iota
	KindOddsChange
	KindBetSettlement
	KindBetCancel
	KindBetStop
	KindFixtureChange
	KindRollbackBetSettlement
	KindRollbackBetCancel
	KindAlive
	KindSnapshotComplete
	KindMatchStatusChange
)

func (k MessageKind) String() string {
	switch k {
	case KindOddsChange:
		return "odds_change"
	case KindBetSettlement:
		return "bet_settlement"
	case KindBetCancel:
		return "bet_cancel"
	case KindBetStop:
		return "bet_stop"
	case KindFixtureChange:
		return "fixture_change"
	case KindRollbackBetSettlement:
		return "rollback_bet_settlement"
	case KindRollbackBetCancel:
		return "rollback_bet_cancel"
	case KindAlive:
		return "alive"
	case KindSnapshotComplete:
		return "snapshot_complete"
	case KindMatchStatusChange:
		return "match_status_change"
	default:
		return "unknown"
	}
}

// PeekEvent extracts the event_id URN and product code from the root XML
// element's attributes without a full unmarshal. Used by the admin feed
// log to stamp each row before dispatching to the type-specific handler.
// Returns empty event_urn / product=0 for messages that don't carry
// those attributes (alive, snapshot_complete).
func PeekEvent(body []byte) (eventURN string, product int, err error) {
	dec := xml.NewDecoder(bytes.NewReader(body))
	for {
		tok, terr := dec.Token()
		if terr != nil {
			return "", 0, fmt.Errorf("peek event: %w", terr)
		}
		se, ok := tok.(xml.StartElement)
		if !ok {
			continue
		}
		for _, a := range se.Attr {
			switch a.Name.Local {
			case "event_id":
				eventURN = a.Value
			case "product":
				fmt.Sscanf(a.Value, "%d", &product)
			}
		}
		return eventURN, product, nil
	}
}

// MapMatchStatusCode translates a numeric Oddin match_status code (the
// `status` attribute on match_status_change, and the `oddin_status_code`
// column we cache on matches) to our match_status enum value. Unknown
// codes map to "" so callers can leave the existing status untouched.
//
// Codes follow the Sportradar UOF convention used by Oddin:
//
//	0  not started     → not_started
//	1  live            → live
//	2  suspended       → suspended
//	3  ended           → closed (final whistle, awaiting confirm)
//	4  closed          → closed (settlement complete)
//	5  cancelled       → cancelled
//	6  delayed         → live (still expected to play)
//	7  interrupted     → suspended
//	8  postponed       → not_started (rescheduled in fixture later)
//	9  abandoned       → cancelled
func MapMatchStatusCode(code int) string {
	switch code {
	case 0:
		return "not_started"
	case 1, 6:
		return "live"
	case 2, 7:
		return "suspended"
	case 3, 4:
		return "closed"
	case 5, 9:
		return "cancelled"
	case 8:
		return "not_started"
	}
	return ""
}

// PeekKind inspects the first XML start-element tag and returns the kind.
// Cheap: does not decode attributes. Useful before full unmarshal so we can
// pick the right struct.
func PeekKind(body []byte) (MessageKind, error) {
	dec := xml.NewDecoder(bytes.NewReader(body))
	for {
		tok, err := dec.Token()
		if err != nil {
			return KindUnknown, fmt.Errorf("peek: %w", err)
		}
		if se, ok := tok.(xml.StartElement); ok {
			switch se.Name.Local {
			case "odds_change":
				return KindOddsChange, nil
			case "bet_settlement":
				return KindBetSettlement, nil
			case "bet_cancel":
				return KindBetCancel, nil
			case "bet_stop":
				return KindBetStop, nil
			case "fixture_change":
				return KindFixtureChange, nil
			case "rollback_bet_settlement":
				return KindRollbackBetSettlement, nil
			case "rollback_bet_cancel":
				return KindRollbackBetCancel, nil
			case "alive":
				return KindAlive, nil
			case "snapshot_complete":
				return KindSnapshotComplete, nil
			case "match_status_change":
				return KindMatchStatusChange, nil
			default:
				return KindUnknown, fmt.Errorf("peek: unknown root element %q", se.Name.Local)
			}
		}
	}
}
