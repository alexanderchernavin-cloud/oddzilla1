// Package rules is the Go port of packages/types/src/slotzilla.ts — the
// SlotZilla game rules: which symbol a Sportradar event contributes,
// which symbol a 5-second window shows, which paytable line three reels
// form and what a line pays. Every function here is pure.
//
// The TypeScript module is the reference and the api evaluates spins
// with it too (the storefront renders reels with it, the backoffice
// previews paytables with it). Both implementations are pinned against
// docs/fixtures/slotzilla-rules.json; rules_test.go reads that file, so
// a divergence fails the build rather than paying a spin differently
// from what the bettor was shown. Ported per the one-Go-module-per-
// service rule rather than shared.
package rules

import (
	"fmt"
	"math/big"
	"strconv"
)

// ── Symbols ─────────────────────────────────────────────────────────────

// Symbol is one of the six reel symbols.
type Symbol string

const (
	P3   Symbol = "P3"
	P2   Symbol = "P2"
	FT   Symbol = "FT"
	MISS Symbol = "MISS"
	FOUL Symbol = "FOUL"
	NONE Symbol = "NONE"
)

// Symbols lists the six reel symbols, highest value first.
var Symbols = []Symbol{P3, P2, FT, MISS, FOUL, NONE}

// Rank orders the symbols: a 3-pointer beats a 2-pointer beats a free
// throw beats a miss beats a foul beats nothing.
var Rank = map[Symbol]int{
	P3:   6,
	P2:   5,
	FT:   4,
	MISS: 3,
	FOUL: 2,
	NONE: 1,
}

// IsSymbol reports whether v names one of the six symbols.
func IsSymbol(v string) bool {
	_, ok := Rank[Symbol(v)]
	return ok
}

// SymbolForEvent returns the symbol a Sportradar timeline event
// contributes and true, or "" and false when the event makes no symbol
// (rebounds, turnovers, timeouts, clock events — everything the v1 reels
// ignore). `goal` is any scored basket and carries points 1 / 2 / 3; a
// goal with an unknown or missing point value is deliberately no symbol
// rather than a guess, so a feed change can never pay a 2-pointer as a
// 3-pointer. NONE is never returned: an empty window is NONE, an event is
// not.
func SymbolForEvent(eventType string, points *int) (Symbol, bool) {
	switch eventType {
	case "goal":
		if points == nil {
			return "", false
		}
		switch *points {
		case 3:
			return P3, true
		case 2:
			return P2, true
		case 1:
			return FT, true
		default:
			return "", false
		}
	case "attempt_missed":
		return MISS, true
	case "foul":
		return FOUL, true
	default:
		return "", false
	}
}

// ── Windows and rounds ──────────────────────────────────────────────────

const (
	// WindowSeconds is how many seconds of match clock one reel watches.
	WindowSeconds = 5
	// RoundWindows is how many consecutive windows one spin covers.
	RoundWindows = 3
	// RoundSeconds is the match-clock length of a spin.
	RoundSeconds = WindowSeconds * RoundWindows
)

// WindowStartOf returns the window (its start second) a match-clock
// reading falls in.
func WindowStartOf(clockSeconds int) int {
	return floorDiv(clockSeconds, WindowSeconds) * WindowSeconds
}

// FirstWindowFor returns where a spin's first window opens: the first
// 5-second mark of the match clock at least leadSeconds after the reading
// we hold. Operator's rule, 2026-09-09 — Betby's 38:33 becomes our 38:35
// — and it is what makes every window one of a fixed set on the match, so
// its symbol is derived once and shared by every spin that covers it.
func FirstWindowFor(clockSeconds, leadSeconds int) int {
	earliest := clockSeconds + leadSeconds
	return ceilDiv(earliest, WindowSeconds) * WindowSeconds
}

// RoundWindowsOf returns the three window starts of a spin that opens at
// windowFrom.
func RoundWindowsOf(windowFrom int) [3]int {
	return [3]int{windowFrom, windowFrom + WindowSeconds, windowFrom + 2*WindowSeconds}
}

// RoundEnd returns the match-clock second after which a spin's last
// window is complete.
func RoundEnd(windowFrom int) int {
	return windowFrom + RoundSeconds
}

// FormatMatchClock renders a cumulative match-clock reading as m:ss.
func FormatMatchClock(seconds int) string {
	s := seconds
	if s < 0 {
		s = 0
	}
	m := s / 60
	r := s % 60
	if r < 10 {
		return strconv.Itoa(m) + ":0" + strconv.Itoa(r)
	}
	return strconv.Itoa(m) + ":" + strconv.Itoa(r)
}

// FormatWindowLabel renders the inclusive label a reel wears: "38:35–38:39".
func FormatWindowLabel(windowFrom int) string {
	return FormatMatchClock(windowFrom) + "–" + FormatMatchClock(windowFrom+WindowSeconds-1)
}

// ── Reels ───────────────────────────────────────────────────────────────

// ReelEvent is the slice of a stored event the reel derivation reads.
type ReelEvent struct {
	// Symbol is empty for an event that makes no symbol.
	Symbol Symbol
	// Seconds is the cumulative match-clock second the scout logged the
	// event at.
	Seconds  int
	Disabled bool
	// Team is "home", "away" or "".
	Team string
	// EventID is Sportradar's event id as a decimal string ("" when
	// unknown), so the tie-break matches the TypeScript module's.
	EventID string
}

// Reel is one window's symbol with the event that produced it.
type Reel struct {
	Symbol Symbol
	// Team is "home", "away" or "" (NONE, or an event without a side).
	Team string
	// EventID is "" for NONE.
	EventID string
}

// ReelForWindow returns the reel for one window: the highest-ranked
// enabled event whose clock reading falls inside [windowFrom, windowFrom
// + 5). Ties break on the earlier event, then the lower id, so the answer
// is deterministic whatever order the events arrive in. A window with
// nothing in it is NONE, which is a symbol like any other and pays from
// the paytable.
func ReelForWindow(events []ReelEvent, windowFrom int) Reel {
	var best *ReelEvent
	to := windowFrom + WindowSeconds
	for i := range events {
		e := &events[i]
		if e.Symbol == "" || e.Disabled {
			continue
		}
		if _, known := Rank[e.Symbol]; !known {
			continue
		}
		if e.Seconds < windowFrom || e.Seconds >= to {
			continue
		}
		if best == nil {
			best = e
			continue
		}
		r := Rank[e.Symbol]
		rb := Rank[best.Symbol]
		switch {
		case r > rb:
			best = e
		case r == rb:
			if e.Seconds < best.Seconds {
				best = e
			} else if e.Seconds == best.Seconds && compareIDs(e.EventID, best.EventID) < 0 {
				best = e
			}
		}
	}
	if best == nil {
		return Reel{Symbol: NONE}
	}
	return Reel{Symbol: best.Symbol, Team: best.Team, EventID: best.EventID}
}

// compareIDs orders decimal id strings numerically without a bigint
// parse: by length, then lexically. An empty id sorts after any id.
func compareIDs(a, b string) int {
	if a == "" && b == "" {
		return 0
	}
	if a == "" {
		return 1
	}
	if b == "" {
		return -1
	}
	if len(a) != len(b) {
		return len(a) - len(b)
	}
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}

// ReelsForRound returns the three reels of a spin from the events it can
// see.
func ReelsForRound(events []ReelEvent, windowFrom int) [3]Reel {
	w := RoundWindowsOf(windowFrom)
	return [3]Reel{ReelForWindow(events, w[0]), ReelForWindow(events, w[1]), ReelForWindow(events, w[2])}
}

// ── Lines ───────────────────────────────────────────────────────────────

// LineKey is `any2:<symbol>` (exactly two reels on the symbol) or
// `all3:<symbol>` (all three).
type LineKey string

// LineKeys lists every line key in the module's canonical order: for
// each symbol highest first, all3 then any2.
var LineKeys = func() []LineKey {
	out := make([]LineKey, 0, 2*len(Symbols))
	for _, s := range Symbols {
		out = append(out, LineKey("all3:"+string(s)), LineKey("any2:"+string(s)))
	}
	return out
}()

// IsLineKey reports whether v is one of the twelve line keys.
func IsLineKey(v string) bool {
	for _, k := range LineKeys {
		if string(k) == v {
			return true
		}
	}
	return false
}

// EvaluateLine returns the paytable line three reels form and true, or
// "" and false when all three differ. With three reels, "exactly two the
// same" is unambiguous — there is never a second pair to choose over.
func EvaluateLine(reels [3]Symbol) (LineKey, bool) {
	a, b, c := reels[0], reels[1], reels[2]
	switch {
	case a == b && b == c:
		return LineKey("all3:" + string(a)), true
	case a == b:
		return LineKey("any2:" + string(a)), true
	case b == c:
		return LineKey("any2:" + string(b)), true
	case a == c:
		return LineKey("any2:" + string(a)), true
	default:
		return "", false
	}
}

// ── Paytable and money ──────────────────────────────────────────────────

// PaytableLines maps a line key to its multiplier in HUNDREDTHS (x100):
// 50 = x0.5, 3500 = x35. Integers so that a payout is exact integer
// arithmetic on the micro stake. A line absent from the table pays
// nothing.
type PaytableLines map[LineKey]int

// PayoutMicro returns stake x multiplier, floored to the micro unit. The
// product is formed exactly and refused when it does not fit int64, which
// no configured stake and multiplier can reach but a corrupt row could.
func PayoutMicro(stakeMicro int64, multiplierX100 int) (int64, error) {
	if multiplierX100 < 0 {
		return 0, fmt.Errorf("multiplierX100 must be a non-negative integer, got %d", multiplierX100)
	}
	if stakeMicro < 0 {
		return 0, fmt.Errorf("stakeMicro must be non-negative, got %d", stakeMicro)
	}
	p := new(big.Int).Mul(big.NewInt(stakeMicro), big.NewInt(int64(multiplierX100)))
	p.Quo(p, big.NewInt(100))
	if !p.IsInt64() {
		return 0, fmt.Errorf("payout overflows int64: stake %d x %d/100", stakeMicro, multiplierX100)
	}
	return p.Int64(), nil
}

// MaxMultiplierX100 returns the top line of a paytable, 0 for an empty one.
func MaxMultiplierX100(lines PaytableLines) int {
	max := 0
	for _, v := range lines {
		if v > max {
			max = v
		}
	}
	return max
}

// ExposureMicro returns the worst case the book carries on one spin:
// stake x the top line, bounded by the operator's max payout per spin.
// This is what the api adds to RiskZilla's open liability for USDC and
// what the per-match cap is checked against; the service releases the
// same number, stored on the spin, at settlement and void.
func ExposureMicro(stakeMicro int64, lines PaytableLines, maxPayoutMicro int64) (int64, error) {
	raw, err := PayoutMicro(stakeMicro, MaxMultiplierX100(lines))
	if err != nil {
		return 0, err
	}
	if raw < maxPayoutMicro {
		return raw, nil
	}
	return maxPayoutMicro, nil
}

// FormatMultiplier renders a x100 multiplier for display: 50 -> "0.5",
// 3500 -> "35", 1825 -> "18.25". Mirrors the TypeScript formatter
// exactly, including dropping only a single trailing zero of the
// fraction.
func FormatMultiplier(x100 int) string {
	whole := x100 / 100
	frac := x100 % 100
	if frac == 0 {
		return strconv.Itoa(whole)
	}
	f := strconv.Itoa(frac)
	if frac < 10 {
		f = "0" + f
	}
	if f[len(f)-1] == '0' {
		f = f[:len(f)-1]
	}
	return strconv.Itoa(whole) + "." + f
}

// DefaultPaytableLines is the indicative v1 paytable from docs/SLOTZILLA.md:
// Betby's grid shape with six symbols, the NONE rows at Betby's x0.5 / x1,
// the play rows scaled to the operator's 97% on the measured rounds, and
// the All-3 lines nobody has observed at Betby's ratios under the payout
// cap. The calibrator (in the api) replaces every number once the corpus
// exists; the migration seeds this table active.
var DefaultPaytableLines = PaytableLines{
	"any2:P3":   3500,
	"all3:P3":   50000,
	"any2:P2":   1800,
	"all3:P2":   20000,
	"any2:FT":   2200,
	"all3:FT":   25000,
	"any2:MISS": 900,
	"all3:MISS": 5500,
	"any2:FOUL": 500,
	"all3:FOUL": 1800,
	"any2:NONE": 50,
	"all3:NONE": 100,
}

// FixedLines are the lines the calibrator holds fixed: empty reels give
// half back / money back and never more.
var FixedLines = []LineKey{"any2:NONE", "all3:NONE"}

// floorDiv divides rounding toward negative infinity, so a negative
// clock reading (never expected) still lands on a grid line.
func floorDiv(a, b int) int {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

// ceilDiv divides rounding toward positive infinity.
func ceilDiv(a, b int) int {
	return -floorDiv(-a, b)
}
