package translate

import (
	"encoding/xml"
	"fmt"
	"time"
)

type fixtureChangeXML struct {
	XMLName    xml.Name `xml:"fixture_change"`
	EventID    string   `xml:"event_id,attr"`
	Product    int      `xml:"product,attr"`
	Timestamp  int64    `xml:"timestamp,attr"`
	ChangeType string   `xml:"change_type,attr"`
	StartTime  *int64   `xml:"start_time,attr,omitempty"`
}

// FixtureChangeDateTime renders Oddin's change_type=2 (DATE_TIME) notice.
// feed-ingester reacts by re-fetching the fixture, which with the REST
// meta API down falls through to its Bifrost fixture fallback — so a
// reschedule seen on Bifrost lands on matches.scheduled_at without this
// service ever writing the row itself.
func FixtureChangeDateTime(eventURN string, product int, nowMs int64, start time.Time) ([]byte, error) {
	if eventURN == "" {
		return nil, fmt.Errorf("fixture_change: empty urn")
	}
	startMs := start.UnixMilli()
	return marshal(fixtureChangeXML{
		EventID:    eventURN,
		Product:    product,
		Timestamp:  nowMs,
		ChangeType: "2",
		StartTime:  &startMs,
	})
}
