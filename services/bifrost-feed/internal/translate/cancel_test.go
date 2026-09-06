package translate

import (
	"encoding/xml"
	"testing"

	"github.com/oddzilla/bifrost-feed/internal/bifrost"
)

// Decode-side struct mirroring services/settlement/internal/oddinxml.BetCancel
// so the test asserts what the consumer will parse.
type betCancel struct {
	XMLName   xml.Name `xml:"bet_cancel"`
	EventID   string   `xml:"event_id,attr"`
	Product   int      `xml:"product,attr"`
	Timestamp int64    `xml:"timestamp,attr"`
	Markets   []struct {
		ID         int    `xml:"id,attr"`
		Specifiers string `xml:"specifiers,attr"`
		StartTime  *int64 `xml:"start_time,attr"`
		EndTime    *int64 `xml:"end_time,attr"`
	} `xml:"market"`
}

func key(pmid int, specs string) bifrost.MarketKey {
	return bifrost.MarketKey{ProviderMarketID: pmid, Specifiers: specs}
}

// The sample match lists maps 1 and 2 and scores two periods: a BO3 that
// ended 2-0. Everything we hold on map 3 is a map nobody played.
func TestMapsPlayedFromSnapshot(t *testing.T) {
	m := sampleMatch(bifrost.MatchClosed)
	if got := MapsPlayed(m); got != 2 {
		t.Fatalf("maps played = %d, want 2", got)
	}
	// Periods win when they say more than the listed markets do.
	m.SimpleScore.Periods = append(m.SimpleScore.Periods, bifrost.SimpleScorePeriod{Number: 3, Home: "16", Away: "9"})
	if got := MapsPlayed(m); got != 3 {
		t.Fatalf("maps played with a third scored period = %d, want 3", got)
	}
	// A CLOSED live-view frame: no markets, no score. Nothing is proven.
	empty := &bifrost.Match{ID: m.ID, State: bifrost.MatchClosed}
	if got := MapsPlayed(empty); got != 0 {
		t.Fatalf("empty snapshot must prove nothing, got %d", got)
	}
}

func TestUnplayedMapCancelsOnlyBeyondLastMap(t *testing.T) {
	m := sampleMatch(bifrost.MatchClosed)
	open := map[bifrost.MarketKey]struct{}{
		key(6, "map=3|variant=way:two|way=two"): {}, // map 3 winner: never played
		key(34, "map=3|threshold=40.5"):         {}, // map 3 kills: never played
		key(34, "map=2|threshold=52.5"):         {}, // dropped line on a PLAYED map: not ours to void
		key(2, "handicap=-1.5"):                 {}, // match-level line: not ours to void
		key(1, "variant=way:two|way=two"):       {}, // match winner: not ours to void
	}
	got := UnplayedMapCancels(m, open)
	if len(got) != 2 {
		t.Fatalf("expected exactly the two map-3 markets, got %+v", got)
	}
	if got[0] != key(6, "map=3|variant=way:two|way=two") || got[1] != key(34, "map=3|threshold=40.5") {
		t.Fatalf("cancel keys must be the map-3 markets in stable order: %+v", got)
	}
}

func TestUnplayedMapCancelsRefuseWithoutProof(t *testing.T) {
	open := map[bifrost.MarketKey]struct{}{key(6, "map=3|variant=way:two|way=two"): {}}
	// Not CLOSED: a live BO3 at 1-0 still has maps 2 and 3 ahead of it.
	if got := UnplayedMapCancels(sampleMatch(bifrost.MatchStarted), open); got != nil {
		t.Fatalf("a live match must never produce cancels, got %+v", got)
	}
	// CLOSED but the snapshot proves nothing: leave it to the historic fetch.
	m := sampleMatch(bifrost.MatchClosed)
	m.MarketGroups = nil
	m.SimpleScore = nil
	if got := UnplayedMapCancels(m, open); got != nil {
		t.Fatalf("an empty CLOSED snapshot must never produce cancels, got %+v", got)
	}
	// Nothing open on our side.
	if got := UnplayedMapCancels(sampleMatch(bifrost.MatchClosed), nil); got != nil {
		t.Fatalf("no open markets, no cancels, got %+v", got)
	}
}

func TestBetCancelRendersFullVoidForConsumer(t *testing.T) {
	m := sampleMatch(bifrost.MatchClosed)
	keys := []bifrost.MarketKey{key(6, "map=3|variant=way:two|way=two"), key(34, "map=3|threshold=40.5")}
	body, err := BetCancel(m, keys, 99)
	if err != nil {
		t.Fatal(err)
	}
	var got betCancel
	if err := xml.Unmarshal(body, &got); err != nil {
		t.Fatalf("consumer decode: %v\n%s", err, body)
	}
	if got.EventID != "od:match:3139010" || got.Timestamp != 99 || got.Product != Product(bifrost.MatchClosed) {
		t.Fatalf("envelope: %+v", got)
	}
	if len(got.Markets) != 2 || got.Markets[0].ID != 6 || got.Markets[0].Specifiers != "map=3|variant=way:two|way=two" || got.Markets[1].ID != 34 {
		t.Fatalf("markets: %+v", got.Markets)
	}
	// No time window: the settlement service treats that as a full cancel
	// of every selection, which is what an unplayed map deserves.
	for _, mk := range got.Markets {
		if mk.StartTime != nil || mk.EndTime != nil {
			t.Fatalf("unplayed-map cancel must carry no window: %+v", mk)
		}
	}
	if b, err := BetCancel(m, nil, 1); err != nil || b != nil {
		t.Fatalf("no keys must render nothing: %v %s", err, b)
	}
}
