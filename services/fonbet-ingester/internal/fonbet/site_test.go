package fonbet

import (
	"net/http"
	"testing"

	"github.com/rs/zerolog"
)

// The line hosts answer 403 without an Origin / Referer for the site the
// line belongs to, so an empty config must still send the default pair
// rather than nothing.
func TestSiteHeaders(t *testing.T) {
	for _, tc := range []struct{ origin, wantOrigin, wantReferer string }{
		{"", DefaultSiteOrigin, DefaultSiteOrigin + "/"},
		{"https://fonbet.kz", "https://fonbet.kz", "https://fonbet.kz/"},
		{"https://fonbet.kz/", "https://fonbet.kz/", "https://fonbet.kz/"},
	} {
		c := New(Config{SiteOrigin: tc.origin}, zerolog.Nop())
		req, err := http.NewRequest(http.MethodGet, "https://example.invalid/", nil)
		if err != nil {
			t.Fatal(err)
		}
		c.setSiteHeaders(req)
		if got := req.Header.Get("Origin"); got != tc.wantOrigin {
			t.Errorf("origin %q: got Origin %q, want %q", tc.origin, got, tc.wantOrigin)
		}
		if got := req.Header.Get("Referer"); got != tc.wantReferer {
			t.Errorf("origin %q: got Referer %q, want %q", tc.origin, got, tc.wantReferer)
		}
	}
}

func TestResolveLogosUsesConfiguredCDN(t *testing.T) {
	resp := &logosResponse{
		Teams:     map[string]string{"7": "l1"},
		TeamLogos: map[string]logoEntry{"l1": {Object: map[string]any{"logoMedium": "/a/b.png"}}},
	}
	for cdn, want := range map[string]string{
		"":                                   DefaultLogoCDN + "/a/b.png",
		"https://cdn-cf.kzac51-resources.kz": "https://cdn-cf.kzac51-resources.kz/a/b.png",
		"https://cdn-ec.example.test/":       "https://cdn-ec.example.test/a/b.png",
	} {
		if got := resolveLogos(resp, cdn).Teams[7]; got != want {
			t.Errorf("cdn %q: got %q, want %q", cdn, got, want)
		}
	}
}
