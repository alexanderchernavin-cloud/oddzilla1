package fonbet

import (
	"reflect"
	"testing"
)

func TestRegistrableDomain(t *testing.T) {
	cases := map[string]string{
		// fon.bet estate (the shipping default) …
		"line-lb51.bk6bba-resources.com":      "bk6bba-resources.com",
		"clientsapi-vk-w.BK6BBA-Resources.ru": "bk6bba-resources.ru",
		"fon.bet":                             "fon.bet",
		// … and the Kazakhstan one.
		"line05-w.kzac51-resources.kz":        "kzac51-resources.kz",
		"clientsapi51-w.KZAC51-Resources.kz.": "kzac51-resources.kz",
		"fonbet.kz":                           "fonbet.kz",
		"localhost":                           "",
		"169.254.169.254":                     "",
		"::1":                                 "",
	}
	for in, want := range cases {
		if got := registrableDomain(in); got != want {
			t.Errorf("registrableDomain(%q) = %q, want %q", in, got, want)
		}
	}
}

// Regression: urls.json is served by a third party and used to set the
// hosts we fetch odds and results from. The first cut adopted any string
// in it — http:// (plaintext downgrade for a feed we pay out against),
// arbitrary schemes, internal addresses. Only https on a domain the
// operator already configured is accepted now.
//
// The corollary matters when moving between the fon.bet and fonbet.kz
// estates: the static host lists ARE the trust anchor, so pointing
// FONBET_URLS_JSON at one site while leaving the other's hosts configured
// makes every discovered host get rejected. TestNormalizeHostsRejects…
// below pins that.
func TestNormalizeHostsTrust(t *testing.T) {
	trusted := trustedSuffixes(
		[]string{"https://line01-w.kzac51-resources.kz", "https://line05-w.kzac51-resources.kz/"},
		[]string{"//clientsapi05-w.kzac51-resources.kz"},
		[]string{"https://fonbet.kz/urls.json"},
	)
	if _, ok := trusted["kzac51-resources.kz"]; !ok {
		t.Fatalf("trusted suffixes missing kzac51-resources.kz: %v", trusted)
	}
	if _, ok := trusted["fonbet.kz"]; !ok {
		t.Fatalf("trusted suffixes missing fonbet.kz: %v", trusted)
	}

	in := []string{
		"//line21-w.kzac51-resources.kz",               // scheme-relative, trusted → https
		"https://line31-w.kzac51-resources.kz/",        // explicit https, trailing slash
		" https://LINE51-W.kzac51-resources.kz ",       // whitespace + case
		"http://line61-w.kzac51-resources.kz",          // plaintext → skipped
		"https://line01-w.evil-resources.example",      // unknown domain → skipped
		"https://169.254.169.254",                      // IP literal → skipped
		"https://user:pw@line05-w.kzac51-resources.kz", // userinfo → skipped
		"ftp://line05-w.kzac51-resources.kz",           // wrong scheme → skipped
		"",
	}
	ok, skipped := normalizeHosts(in, trusted)
	wantOK := []string{
		"https://line21-w.kzac51-resources.kz",
		"https://line31-w.kzac51-resources.kz",
		"https://LINE51-W.kzac51-resources.kz",
	}
	if !reflect.DeepEqual(ok, wantOK) {
		t.Fatalf("accepted = %v, want %v", ok, wantOK)
	}
	if len(skipped) != 5 {
		t.Fatalf("skipped = %v, want 5 entries", skipped)
	}
}

// A half-finished site move leaves the operator's static lists pointing at
// one estate and urls.json at the other. Every discovered host is then
// off-domain and rejected, and DiscoverHosts keeps the static list — which
// is the safe outcome, but it is silent apart from the skipped-hosts
// warning, so it is worth being able to recognise.
func TestNormalizeHostsRejectsCrossEstateDiscovery(t *testing.T) {
	trusted := trustedSuffixes(
		[]string{"https://line01-w.kzac51-resources.kz"},
		[]string{"https://clientsapi05-w.kzac51-resources.kz"},
		[]string{"https://fonbet.kz/urls.json"},
	)
	ok, skipped := normalizeHosts([]string{
		"//line-lb51.bk6bba-resources.com",
		"//line-lb52.bk6bba-resources.ru",
	}, trusted)
	if len(ok) != 0 {
		t.Fatalf("fon.bet hosts must not be adopted under KZ trust: %v", ok)
	}
	if len(skipped) != 2 {
		t.Fatalf("both hosts should be reported skipped, got %v", skipped)
	}
}
