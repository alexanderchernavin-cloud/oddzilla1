package fonbet

import (
	"reflect"
	"testing"
)

func TestRegistrableDomain(t *testing.T) {
	cases := map[string]string{
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
