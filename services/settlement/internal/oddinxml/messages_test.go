package oddinxml

import (
	"encoding/xml"
	"testing"
)

func TestPeekKind(t *testing.T) {
	cases := []struct {
		body string
		want MessageKind
	}{
		{`<?xml version="1.0"?><odds_change event_id="od:match:1"/>`, KindOddsChange},
		{`<bet_settlement event_id="od:match:1"/>`, KindBetSettlement},
		{`<bet_cancel event_id="od:match:1"/>`, KindBetCancel},
		{`<bet_stop event_id="od:match:1"/>`, KindBetStop},
		{`<fixture_change event_id="od:match:1"/>`, KindFixtureChange},
		{`<rollback_bet_settlement event_id="od:match:1"/>`, KindRollbackBetSettlement},
		{`<rollback_bet_cancel event_id="od:match:1"/>`, KindRollbackBetCancel},
		{`<alive product="1" timestamp="1"/>`, KindAlive},
		{`<snapshot_complete product="1" timestamp="1" request_id="1"/>`, KindSnapshotComplete},
	}
	for _, c := range cases {
		got, err := PeekKind([]byte(c.body))
		if err != nil {
			t.Fatalf("peek(%q): %v", c.body, err)
		}
		if got != c.want {
			t.Fatalf("peek(%q): got %v, want %v", c.body, got, c.want)
		}
	}
}

func TestDecodeOddsChange(t *testing.T) {
	body := []byte(`
<odds_change event_id="od:match:112663" product="2" timestamp="1665406912728">
  <odds>
    <market id="4" specifiers="map=1" status="1">
      <outcome id="1" odds="1.85" active="1"/>
      <outcome id="2" odds="1.95" active="1"/>
    </market>
    <market id="1" specifiers="" status="1">
      <outcome id="1" odds="2.10" active="1"/>
      <outcome id="2" odds="1.70" active="1"/>
    </market>
  </odds>
</odds_change>
`)
	var msg OddsChange
	if err := xml.Unmarshal(body, &msg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if msg.EventID != "od:match:112663" {
		t.Fatalf("event_id: %q", msg.EventID)
	}
	if msg.Product != 2 {
		t.Fatalf("product: %d", msg.Product)
	}
	if msg.Timestamp != 1665406912728 {
		t.Fatalf("timestamp: %d", msg.Timestamp)
	}
	if msg.Odds == nil || len(msg.Odds.Markets) != 2 {
		t.Fatalf("markets: %#v", msg.Odds)
	}
	mapMarket := msg.Odds.Markets[0]
	if mapMarket.ID != 4 || mapMarket.Specifiers != "map=1" || mapMarket.Status != 1 {
		t.Fatalf("map market: %#v", mapMarket)
	}
	if len(mapMarket.Outcomes) != 2 || mapMarket.Outcomes[0].Odds != "1.85" {
		t.Fatalf("map outcomes: %#v", mapMarket.Outcomes)
	}
}

func TestDecodeBetSettlement(t *testing.T) {
	body := []byte(`
<bet_settlement event_id="od:match:42" product="2" timestamp="1700000000000" certainty="2">
  <outcomes>
    <market id="1" specifiers="" status="-3">
      <outcome id="1" result="1" void_factor="0"/>
      <outcome id="2" result="0" void_factor="0"/>
    </market>
    <market id="4" specifiers="map=1" status="-3">
      <outcome id="1" result="0" void_factor="0"/>
      <outcome id="2" result="1" void_factor="0"/>
    </market>
  </outcomes>
</bet_settlement>
`)
	var msg BetSettlement
	if err := xml.Unmarshal(body, &msg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if msg.EventID != "od:match:42" || msg.Certainty != 2 {
		t.Fatalf("%#v", msg)
	}
	if msg.Outcomes == nil || len(msg.Outcomes.Markets) != 2 {
		t.Fatalf("markets: %#v", msg.Outcomes)
	}
	m := msg.Outcomes.Markets[1]
	if m.ID != 4 || m.Specifiers != "map=1" || m.Outcomes[1].Result != "1" {
		t.Fatalf("map winner: %#v", m)
	}
}

func TestParseURN(t *testing.T) {
	cases := []struct {
		in       string
		wantType string
		wantID   string
		wantErr  bool
	}{
		{"od:match:112663", "match", "112663", false},
		{"od:sport:5", "sport", "5", false},
		{"od:dynamic_outcomes:27|v1", "dynamic_outcomes", "27|v1", false},
		{"invalid", "", "", true},
		{"od::123", "", "", true},
	}
	for _, c := range cases {
		u, err := ParseURN(c.in)
		if c.wantErr {
			if err == nil {
				t.Fatalf("parse(%q): expected error", c.in)
			}
			continue
		}
		if err != nil {
			t.Fatalf("parse(%q): %v", c.in, err)
		}
		if u.Type != c.wantType || u.ID != c.wantID {
			t.Fatalf("parse(%q): got %+v", c.in, u)
		}
	}
}
