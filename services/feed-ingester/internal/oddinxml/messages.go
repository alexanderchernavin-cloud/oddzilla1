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

	Odds *OddsBlock `xml:"odds"`
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
	default:
		return "unknown"
	}
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
			default:
				return KindUnknown, fmt.Errorf("peek: unknown root element %q", se.Name.Local)
			}
		}
	}
}
