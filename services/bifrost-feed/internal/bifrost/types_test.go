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
	// Bifrost's `handicap=-1.5` is the AMQP feed's `handicap=1.5`; the
	// parsed key carries the corrected sign (see TestHandicapSignFlip).
	urn, key, err := ParseMarketID("bWFya2V0L29kOm1hdGNoOjMxMzkwMTAvMi8yLWhhbmRpY2FwPS0xLjU=")
	if err != nil || urn != "od:match:3139010" || key.ProviderMarketID != 2 || key.Specifiers != "handicap=1.5" {
		t.Fatalf("handicap market: %v %s %+v", err, urn, key)
	}
	urn, key, oid, err := ParseOutcomeID("b3V0Y29tZS9vZDptYXRjaDozMTM5MDEwLzIvMi1oYW5kaWNhcD0tMS41LzE=")
	if err != nil || urn != "od:match:3139010" || key.ProviderMarketID != 2 || key.Specifiers != "handicap=1.5" || oid != "1" {
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
	// Pure canonicaliser: trims and sorts, never rewrites a value. The
	// handicap sign correction is a separate, named step so the two
	// concerns can't be confused (or applied twice).
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

// Bifrost states a handicap from the opposite side to Oddin's AMQP feed, so
// every market key it hands us has to be flipped onto the AMQP convention
// before it can name a market row. Getting this wrong is not a label bug:
// settlement is dual-source, so an Oddin bet_settlement would grade the
// opposite line of the one the backup feed priced.
func TestHandicapSignFlip(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		// The line the storefront showed as Falcons -1.5 at 1.15 while
		// their moneyline was 1.55 (production match 1163395).
		{"handicap=-1.5", "handicap=1.5"},
		{"handicap=1.5", "handicap=-1.5"},
		{"handicap=+1.5", "handicap=-1.5"},
		{"handicap=-2.5", "handicap=2.5"},
		// Zero has no sign to flip, and must never come back as "-0":
		// that would hash to a different market than the AMQP row.
		{"handicap=0", "handicap=0"},
		{"handicap=-0", "handicap=0"},
		// Magnitude text survives verbatim — specifiers_hash is taken
		// over the string, so a float round-trip would fork the key.
		{"handicap=1.50", "handicap=-1.50"},
		// Other keys are untouched, including the other line specifier.
		{"threshold=2.5", "threshold=2.5"},
		{"handicap=-1.5|map=2", "handicap=1.5|map=2"},
		{"map=1|handicap=-3.5|variant=way:two", "handicap=3.5|map=1|variant=way:two"},
		{"", ""},
		// Not a number: leave it alone rather than invent a value.
		{"handicap=draw", "handicap=draw"},
	} {
		if got := NormalizeSpecifiers(tc.in); got != tc.want {
			t.Errorf("NormalizeSpecifiers(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// Flipping twice is the identity, so a key that has already been through
// the parser can never drift by being normalised again.
func TestHandicapSignFlipIsAnInvolution(t *testing.T) {
	for _, in := range []string{"handicap=-1.5", "handicap=2.5", "map=2|handicap=-0.5", "threshold=1.5"} {
		once := NormalizeSpecifiers(in)
		if twice := NormalizeSpecifiers(once); twice != CanonicalSpecifiers(in) {
			t.Errorf("%q: flipped twice = %q, want %q", in, twice, CanonicalSpecifiers(in))
		}
	}
}
