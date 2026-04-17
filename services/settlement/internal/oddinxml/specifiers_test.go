// Golden-fixture test. Loads docs/fixtures/specifiers.json and verifies
// every row round-trips identically to the TS implementation.

package oddinxml

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

func loadFixture(t *testing.T) []fixtureCase {
	t.Helper()
	// Walk up until we find docs/fixtures/specifiers.json. Test cwd is the
	// package dir; the fixture lives four levels up.
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
	return cases
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
	for _, c := range loadFixture(t) {
		t.Run(c.Name, func(t *testing.T) {
			// Parse round-trip
			parsed := Parse(c.Raw)
			if len(parsed) != len(c.Specifiers) {
				t.Fatalf("parse(%q): got %v, want %v", c.Raw, parsed, c.Specifiers)
			}
			for k, v := range c.Specifiers {
				if parsed[k] != v {
					t.Fatalf("parse(%q): key %q got %q, want %q", c.Raw, k, parsed[k], v)
				}
			}

			// Canonical string match
			got := Canonical(c.Specifiers)
			if got != c.Canonical {
				t.Fatalf("canonical: got %q, want %q", got, c.Canonical)
			}

			// Hash match (sha256 of canonical)
			hash := Hash(c.Specifiers)
			gotHex := hex.EncodeToString(hash)
			if gotHex != c.Sha256Hex {
				t.Fatalf("sha256: got %s, want %s", gotHex, c.Sha256Hex)
			}

			// HashFromRaw agrees when raw is the canonical form (i.e. sorted
			// already). For out-of-order raws, HashFromRaw still produces the
			// canonical hash because it parses then re-sorts.
			if gotHex2 := hex.EncodeToString(HashFromRaw(c.Raw)); gotHex2 != c.Sha256Hex {
				t.Fatalf("HashFromRaw: got %s, want %s", gotHex2, c.Sha256Hex)
			}
		})
	}
}
