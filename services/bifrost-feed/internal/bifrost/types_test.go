package bifrost

import (
	"encoding/base64"
	"testing"
)

func enc(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func TestDecodeIDsCapturedFromProduction(t *testing.T) {
	// Ids exactly as Bifrost served them on 2026-09-03.
	kind, path, err := DecodeID("bWF0Y2gvb2Q6bWF0Y2g6MzEzOTAxMA==")
	if err != nil || kind != "match" || path[0] != "od:match:3139010" {
		t.Fatalf("match id: %v %s %v", err, kind, path)
	}
	urn, key, err := ParseMarketID("bWFya2V0L29kOm1hdGNoOjMxMzkwMTAvMi8yLWhhbmRpY2FwPS0xLjU=")
	if err != nil || urn != "od:match:3139010" || key.ProviderMarketID != 2 || key.Specifiers != "handicap=-1.5" {
		t.Fatalf("handicap market: %v %s %+v", err, urn, key)
	}
	urn, key, oid, err := ParseOutcomeID("b3V0Y29tZS9vZDptYXRjaDozMTM5MDEwLzIvMi1oYW5kaWNhcD0tMS41LzE=")
	if err != nil || urn != "od:match:3139010" || key.ProviderMarketID != 2 || key.Specifiers != "handicap=-1.5" || oid != "1" {
		t.Fatalf("handicap outcome: %v %s %+v %s", err, urn, key, oid)
	}
	_, key, err = ParseMarketID("bWFya2V0L29kOm1hdGNoOjMxMzkwMTAvNnx2YXJpYW50PXdheTp0d298bWFwPTIvNi1tYXA9Mnx2YXJpYW50PXdheTp0d298d2F5PXR3bw==")
	if err != nil || key.ProviderMarketID != 6 || key.Specifiers != "map=2|variant=way:two|way=two" {
		t.Fatalf("map winner market: %v %+v", err, key)
	}
	_, key, err = ParseMarketID(enc("market/od:match:1/1|variant=way:two/1-variant=way:two|way=two"))
	if err != nil || key.ProviderMarketID != 1 || key.Specifiers != "variant=way:two|way=two" {
		t.Fatalf("winner market: %v %+v", err, key)
	}
	_, key, err = ParseMarketID(enc("market/od:match:1/37/37-side=home"))
	if err != nil || key.ProviderMarketID != 37 || key.Specifiers != "side=home" {
		t.Fatalf("side market: %v %+v", err, key)
	}
	_, key, err = ParseMarketID(enc("market/od:match:1/9/9"))
	if err != nil || key.ProviderMarketID != 9 || key.Specifiers != "" {
		t.Fatalf("specifier-less market: %v %+v", err, key)
	}
}

func TestCanonicalSpecifiersSortsAndTrims(t *testing.T) {
	if got := CanonicalSpecifiers("way=two|map=2|variant=way:two"); got != "map=2|variant=way:two|way=two" {
		t.Fatalf("sort: %q", got)
	}
	if got := CanonicalSpecifiers(" handicap = -1.5 "); got != "handicap=-1.5" {
		t.Fatalf("trim: %q", got)
	}
	if got := CanonicalSpecifiers(""); got != "" {
		t.Fatalf("empty: %q", got)
	}
}

func TestTeamAndTournamentURNs(t *testing.T) {
	team := Team{ID: "dGVhbS9vZDpjb21wZXRpdG9yOjE2NTU="}
	if team.URN() != "od:competitor:1655" {
		t.Fatalf("team urn: %q", team.URN())
	}
	tour := Tournament{ID: "dG91cm5hbWVudC9vZDp0b3VybmFtZW50OjE0NjEx"}
	if tour.URN() != "od:tournament:14611" {
		t.Fatalf("tournament urn: %q", tour.URN())
	}
	sport := Sport{ID: "c3BvcnQvb2Q6c3BvcnQ6Mg=="}
	if sport.URN() != "od:sport:2" {
		t.Fatalf("sport urn: %q", sport.URN())
	}
	if _, _, err := DecodeID("not base64!"); err == nil {
		t.Fatal("garbage must error")
	}
	if _, _, err := ParseMarketID(enc("team/od:competitor:1")); err == nil {
		t.Fatal("wrong kind must error")
	}
}
