// Market specifier canonicalization.
//
// INVARIANT: the output of Canonical() and Hash() MUST match the TypeScript
// implementation at packages/types/src/specifiers.ts byte-for-byte. Both are
// tested against docs/fixtures/specifiers.json. If this diverges, settlement
// worker silently fails to match tickets to settled markets.

package oddinxml

import (
	"crypto/sha256"
	"sort"
	"strings"
)

// Specifiers is the parsed (key, value) map from Oddin's pipe-separated form.
type Specifiers map[string]string

// Parse converts a raw Oddin specifiers attribute (`k1=v1|k2=v2`) into a map.
// Values containing `=` are preserved (split only at the first `=`).
// Returns nil for an empty input.
func Parse(raw string) Specifiers {
	if raw == "" {
		return Specifiers{}
	}
	out := make(Specifiers)
	for _, pair := range strings.Split(raw, "|") {
		eq := strings.IndexByte(pair, '=')
		if eq < 0 {
			continue
		}
		out[pair[:eq]] = pair[eq+1:]
	}
	return out
}

// Canonical returns the canonical pipe-separated form: `k1=v1|k2=v2` with
// keys sorted lexicographically by byte. An empty map serializes to "".
func Canonical(s Specifiers) string {
	if len(s) == 0 {
		return ""
	}
	keys := make([]string, 0, len(s))
	for k := range s {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var buf strings.Builder
	for i, k := range keys {
		if i > 0 {
			buf.WriteByte('|')
		}
		buf.WriteString(k)
		buf.WriteByte('=')
		buf.WriteString(s[k])
	}
	return buf.String()
}

// Hash returns sha256 of the canonical form as a 32-byte slice, suitable
// for storing in markets.specifiers_hash (BYTEA).
func Hash(s Specifiers) []byte {
	sum := sha256.Sum256([]byte(Canonical(s)))
	return sum[:]
}

// HashFromRaw is a convenience for when the caller has the raw attribute.
func HashFromRaw(raw string) []byte {
	return Hash(Parse(raw))
}
