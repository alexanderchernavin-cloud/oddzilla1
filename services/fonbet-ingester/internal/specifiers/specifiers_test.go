// Golden-fixture test. Loads docs/fixtures/specifiers.json and verifies
// every row round-trips identically to the TS + feed-ingester
// implementations.

package specifiers

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type fixtureCase struct {
	Name       string            `json:"name"`
	Raw        string            `json:"raw"`
	Specifiers map[string]string `json:"specifiers"`
	Canonical  string            `json:"canonical"`
	Sha256Hex  string            `json:"sha256Hex"`
}

func locateFixture(rel string) (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		candidate := filepath.Join(dir, rel)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", os.ErrNotExist
		}
		dir = parent
	}
}

func TestSpecifiersGolden(t *testing.T) {
	path, err := locateFixture("docs/fixtures/specifiers.json")
	if err != nil {
		t.Fatalf("locate fixture: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var cases []fixtureCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			parsed := Parse(c.Raw)
			if len(parsed) != len(c.Specifiers) {
				t.Fatalf("parse(%q): got %v, want %v", c.Raw, parsed, c.Specifiers)
			}
			for k, v := range c.Specifiers {
				if parsed[k] != v {
					t.Fatalf("parse(%q): key %q got %q, want %q", c.Raw, k, parsed[k], v)
				}
			}
			if got := Canonical(c.Specifiers); got != c.Canonical {
				t.Fatalf("canonical: got %q, want %q", got, c.Canonical)
			}
			if got := hex.EncodeToString(Hash(c.Specifiers)); got != c.Sha256Hex {
				t.Fatalf("sha256: got %s, want %s", got, c.Sha256Hex)
			}
			if got := hex.EncodeToString(HashFromRaw(c.Raw)); got != c.Sha256Hex {
				t.Fatalf("HashFromRaw: got %s, want %s", got, c.Sha256Hex)
			}
		})
	}
}

func TestSafeValue(t *testing.T) {
	if got := SafeValue(" a|b=c "); got != "a/b:c" {
		t.Fatalf("SafeValue: got %q", got)
	}
}
