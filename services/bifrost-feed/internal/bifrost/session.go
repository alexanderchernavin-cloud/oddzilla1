package bifrost

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

// newSessionID makes the UUID-shaped `x-sbi` value Bifrost expects. It is
// a browser-session marker on their side; any well-formed random UUID is
// accepted (verified 2026-09-03). Falls back to a fixed value if the OS
// entropy source fails, which only affects their analytics grouping.
func newSessionID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])
}
