package fonbet

import (
	"testing"

	"github.com/rs/zerolog"
)

func ptr(v int) *int { return &v }

// Pins the two rules TournamentIcons exists for.
//
// (1) The join. tournamentInfos is keyed by its own id space, NOT by the
// segment id the rest of the ingester uses — the segment node's
// tournamentInfoId is the bridge, and getting that wrong silently stamps
// one league's crest onto another's row.
//
// (2) Country flags are dropped. Fonbet has a real mark for only about half
// its leagues and falls back to the country flag for the rest; our sidebar
// already carries that flag on the category header the row renders under,
// so importing it would repeat the same flag down a whole country bucket.
// Measured on the live line 2026-09-05: of 761 segments, 384 carry a real
// mark and 107 more carry nothing but a flag.
func TestTournamentIcons(t *testing.T) {
	c := New(Config{LogoCDN: "https://cdn.example/"}, zerolog.Nop())
	resp := &ListResponse{
		Sports: []Sport{
			{ID: 11918, Kind: "segment", Name: "England. Premier League", TournamentInfoID: ptr(53)},
			{ID: 37273, Kind: "segment", Name: "England. Cup. Qualifying stage", TournamentInfoID: ptr(60)},
			{ID: 12018, Kind: "segment", Name: "England. Championship", TournamentInfoID: ptr(56)},
			{ID: 99001, Kind: "segment", Name: "Slovakia. Extra-liga", TournamentInfoID: ptr(70)},
			{ID: 99002, Kind: "segment", Name: "No info block at all"},
			{ID: 1, Kind: "sport", Name: "Football"},
		},
		TournamentInfos: []TournamentInfo{
			{ID: 53, Icon: "/ContentCommon/Logotypes/Tournament/Football/england_pl.svg"},
			{ID: 60, Icon: "/ContentCommon/Logotypes/CompetitionLogos/Football/fa_cup.png"},
			{ID: 56}, // Championship: Fonbet has no mark for it
			{ID: 70, Icon: "/ContentCommon/NewFlags/Circle/Slovakia.svg"}, // flag, not a mark
			{ID: 71, Icon: "ContentCommon/relative.svg"},                  // malformed, no leading slash
		},
	}
	got := c.TournamentIcons(resp)
	want := map[int]string{
		11918: "https://cdn.example/ContentCommon/Logotypes/Tournament/Football/england_pl.svg",
		37273: "https://cdn.example/ContentCommon/Logotypes/CompetitionLogos/Football/fa_cup.png",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d icons %v, want %d", len(got), got, len(want))
	}
	for id, url := range want {
		if got[id] != url {
			t.Errorf("segment %d = %q, want %q", id, got[id], url)
		}
	}
}

// An empty LogoCDN must still produce absolute URLs — the paths are
// root-relative and would otherwise be written into logo_url as-is and
// resolve against the storefront's own origin.
func TestTournamentIconsDefaultCDN(t *testing.T) {
	c := New(Config{}, zerolog.Nop())
	got := c.TournamentIcons(&ListResponse{
		Sports:          []Sport{{ID: 7, Kind: "segment", TournamentInfoID: ptr(1)}},
		TournamentInfos: []TournamentInfo{{ID: 1, Icon: "/a/b.svg"}},
	})
	if want := DefaultLogoCDN + "/a/b.svg"; got[7] != want {
		t.Errorf("got %q, want %q", got[7], want)
	}
}

func TestTournamentIconsEmpty(t *testing.T) {
	c := New(Config{}, zerolog.Nop())
	if got := c.TournamentIcons(nil); got != nil {
		t.Errorf("nil response: got %v, want nil", got)
	}
	// A snapshot whose every icon is a flag must yield nil, not an empty
	// map that reads as "we looked and found marks".
	got := c.TournamentIcons(&ListResponse{
		Sports:          []Sport{{ID: 7, Kind: "segment", TournamentInfoID: ptr(1)}},
		TournamentInfos: []TournamentInfo{{ID: 1, Icon: "/ContentCommon/NewFlags/Circle/Spain.svg"}},
	})
	if got != nil {
		t.Errorf("flags-only: got %v, want nil", got)
	}
}
