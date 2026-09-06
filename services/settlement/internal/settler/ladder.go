package settler

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/oddzilla/settlement/internal/oddinxml"
	"github.com/oddzilla/settlement/internal/store"
)

// ─── Ladder-line inference ─────────────────────────────────────────────────
//
// Why this exists: the Bifrost backup feed settles only the markets still in
// its CLOSED view, and it drops every line it replaced during the match. On
// the AMQP feed those lines arrive settled; on the backup they stay open
// forever with a real result nobody voiced. Measured 2026-09-06 on the
// matches that started on 09-05: 3 340 open total / handicap lines on
// closed Oddin matches, 3 247 of them with at least one settled sibling.
//
// What it does: every settled sibling of the same family (same market type,
// same other specifiers, a different line) is a statement about the one
// integer the family settles on — the total, or the home margin. "Over 25.5
// won" says the total was 26 or more; "under 27.5 won" says 27 or less; a
// push says exactly 27; a half-won quarter line pins it to one value too.
// The intersection of those statements is an interval, and an open line is
// settled when every value in the interval grades it the same way — which
// covers whole, half AND quarter lines, and produces pushes and half
// results where the arithmetic says so. A line the interval does not decide
// is left exactly as it was, for the operator. Nothing here voids anything.
//
// Measured on the first production pass (2026-09-06): with the earlier
// strict-inequality rule 6 643 of 7 313 candidates were "undecided", almost
// all because the ladder carried a quarter line or a push that PINNED the
// number while the rule only read full won / lost siblings. The interval
// form decides those.
//
// Two conventions it depends on, both read off production on 2026-09-06:
// Oddin totals carry outcomes 4 = under and 5 = over; Oddin handicaps carry
// 1 = home and 2 = away with the line stated as the home side's handicap.
// A family with any other outcome set (the 1/2 "Nth kill" race markets
// also carry a threshold; the 154-157 winner-and-total combos) is refused
// rather than read.

// ladderLookbackDays bounds the scan to recent fixtures; anything older is
// past both feeds' replay windows and is the operator's to review.
const ladderLookbackDays = 7

// valueRange bounds the brute-force search for the settled number. Kill
// totals in an esports map run to the low hundreds; nothing Oddin quotes a
// line on exceeds this in either direction.
const valueRange = 500

// LadderStats summarises one inference pass.
type LadderStats struct {
	Candidates int
	Settled    int
	Skipped    map[string]int
}

// ReconcileLadderLines settles every open total / handicap line on a closed
// Oddin match whose settled siblings decide its result, through the
// ordinary apply-once settle path. Safe on a timer: a line settled on one
// pass is terminal and never a candidate again, and a line the siblings do
// not decide is skipped with a reason and stays untouched.
func (s *Settler) ReconcileLadderLines(ctx context.Context) (LadderStats, error) {
	stats := LadderStats{Skipped: map[string]int{}}
	lines, err := store.OpenLadderLinesWithSettledSiblings(ctx, s.store.Pool(), ladderLookbackDays)
	if err != nil {
		return stats, err
	}
	stats.Candidates = len(lines)
	now := time.Now().UnixMilli()
	closedMatches := map[string]struct{}{}
	for _, ln := range lines {
		if ctx.Err() != nil {
			return stats, ctx.Err()
		}
		if ln.OutcomeResults != "" {
			// The market is open but its outcomes already carry results: a
			// settle followed by a cancel and a rollback of that cancel left
			// the row at status 1 (seen on production 2026-09-06). The
			// apply-once insert would treat our settle as a replay and
			// change nothing, so this is not ours to fix — it needs the
			// rollback path, not inference.
			stats.Skipped["outcomes already carry results"]++
			continue
		}
		var specs oddinxml.Specifiers
		if err := json.Unmarshal([]byte(ln.SpecifiersJSON), &specs); err != nil || specs == nil {
			stats.Skipped["unreadable specifiers"]++
			continue
		}
		outs, why, ok := inferLine(ln.LineKey, specs[ln.LineKey], ln.OutcomeIDs, ln.Siblings)
		if !ok {
			stats.Skipped[why]++
			continue
		}
		market := oddinxml.Market{
			ID:         ln.ProviderMarketID,
			Specifiers: oddinxml.Canonical(specs),
			Status:     -3,
			// Provenance for the settlements audit row: what decided this
			// line. Read by nothing, kept for the operator.
			ExtendedSpecifiers: "inferred_from=" + why,
			Outcomes:           outs,
		}
		if err := s.applyMarketSettle(ctx, ln.EventURN, now, nil, market); err != nil {
			s.log.Warn().Err(err).Str("event", ln.EventURN).Int("market", ln.ProviderMarketID).Str("specifiers", market.Specifiers).Msg("ladder inference: apply failed")
			stats.Skipped["apply failed"]++
			continue
		}
		stats.Settled++
		closedMatches[ln.EventURN] = struct{}{}
		s.log.Info().Str("event", ln.EventURN).Int("market", ln.ProviderMarketID).Str("specifiers", market.Specifiers).Str("from", why).Msg("ladder inference: settled from siblings")
	}
	for urn := range closedMatches {
		if closedMatchID, closed, err := store.MarkMatchClosedIfAllMarketsTerminal(ctx, s.store.Pool(), urn); err != nil {
			s.log.Warn().Err(err).Str("event", urn).Msg("ladder inference: mark match closed failed; continuing")
		} else if closed {
			s.publishMatchStatus(ctx, closedMatchID, "closed", now)
		}
	}
	return stats, nil
}

// graded is one side's result in Oddin's wire form.
type graded struct{ res, vf string }

var (
	gWon      = graded{"1", ""}
	gLost     = graded{"0", ""}
	gVoid     = graded{"1", "1"}
	gHalfWon  = graded{"1", "0.5"}
	gHalfLost = graded{"0", "0.5"}
)

// rank orders results the way they move as the settled number grows, so
// "same result at both ends of the interval" implies the same result all
// the way across (gradeHigh is monotone in the number).
func (g graded) rank() int {
	switch g {
	case gLost:
		return 0
	case gHalfLost:
		return 1
	case gVoid:
		return 2
	case gHalfWon:
		return 3
	case gWon:
		return 4
	}
	return -1
}

// gradeHigh grades the HIGH side of a line — over for a total, home for a
// handicap — given the settled number: the total, or the home margin.
// Handicap lines are the home side's, so the diff is margin + line; a total
// is over when the number exceeds the line. Quarter lines split into two
// half-stakes exactly as the Fonbet grader does (fonbet-ingester
// internal/settle/rules.go gradeTotal / gradeHandicap).
func gradeHigh(kind string, value int, line float64) graded {
	frac := math.Abs(line - math.Trunc(line))
	if math.Abs(frac-0.25) < 1e-9 || math.Abs(frac-0.75) < 1e-9 {
		return combine(gradeHigh(kind, value, line-0.25), gradeHigh(kind, value, line+0.25))
	}
	var diff float64
	if kind == "handicap" {
		diff = float64(value) + line
	} else {
		diff = float64(value) - line
	}
	switch {
	case diff > 1e-9:
		return gWon
	case diff < -1e-9:
		return gLost
	}
	return gVoid
}

// combine merges the two half-stakes of a quarter line.
func combine(x, y graded) graded {
	switch {
	case x == gWon && y == gWon:
		return gWon
	case x == gLost && y == gLost:
		return gLost
	case (x == gWon && y == gVoid) || (x == gVoid && y == gWon):
		return gHalfWon
	case (x == gLost && y == gVoid) || (x == gVoid && y == gLost):
		return gHalfLost
	}
	return gVoid
}

// mirror is the opposite side's result.
func mirror(g graded) graded {
	switch g {
	case gWon:
		return gLost
	case gLost:
		return gWon
	case gHalfWon:
		return gHalfLost
	case gHalfLost:
		return gHalfWon
	}
	return gVoid
}

// fromStored maps a market_outcomes.result enum value onto the wire form.
func fromStored(result string) (graded, bool) {
	switch result {
	case "won":
		return gWon, true
	case "lost":
		return gLost, true
	case "void":
		return gVoid, true
	case "half_won":
		return gHalfWon, true
	case "half_lost":
		return gHalfLost, true
	}
	return graded{}, false
}

// inferLine decides one open line from its settled siblings. It returns the
// settled outcomes in Oddin's wire form and a description of what decided
// the line, or a refusal reason.
//
// Every sibling narrows the interval of integers the family's number can
// be: the values v for which gradeHigh(v, X) reproduces the sibling's
// stored result (a contiguous range, since the grade is monotone in v; a
// push or a half result pins a single value). An empty intersection means
// the siblings contradict each other and the line is refused. The open line
// Y is decided when both ends of the interval grade it identically, which
// by monotonicity means every value between does too — so an exact pin
// settles Y with the real result including a push or a half result, and a
// one-sided bound settles Y only when the whole range agrees.
func inferLine(lineKey, openLine, outcomeIDs string, siblings []store.LadderSibling) ([]oddinxml.Outcome, string, bool) {
	y, err := strconv.ParseFloat(strings.TrimSpace(openLine), 64)
	if err != nil {
		return nil, "unreadable line", false
	}
	var hiID, loID string // the outcome that wins when the number is HIGH / LOW
	switch lineKey {
	case "threshold":
		if outcomeIDs != "4,5" {
			return nil, "not an over/under total", false
		}
		hiID, loID = "5", "4" // over wins on a high total
	case "handicap":
		if outcomeIDs != "1,2" {
			return nil, "not a home/away handicap", false
		}
		hiID, loID = "1", "2" // home wins on a high margin
	default:
		return nil, "unknown line key", false
	}

	lo, hi := -valueRange, valueRange
	var used []string
	for _, sib := range siblings {
		x, err := strconv.ParseFloat(strings.TrimSpace(sib.Line), 64)
		if err != nil {
			continue
		}
		observed, ok := siblingResult(sib.Results, hiID, loID)
		if !ok {
			continue
		}
		// The values consistent with this sibling form one contiguous range.
		sLo, sHi := valueRange+1, -valueRange-1
		for v := -valueRange; v <= valueRange; v++ {
			if gradeHigh(lineKey, v, x) == observed {
				if v < sLo {
					sLo = v
				}
				if v > sHi {
					sHi = v
				}
			}
		}
		if sLo > sHi {
			continue // no integer reproduces the stored result; ignore the sibling
		}
		if sLo > lo {
			lo = sLo
		}
		if sHi < hi {
			hi = sHi
		}
		used = append(used, lineKey+"="+strings.TrimSpace(sib.Line))
	}
	if len(used) == 0 {
		return nil, "no usable sibling", false
	}
	if lo > hi {
		return nil, "siblings disagree", false
	}
	if lo == -valueRange && hi == valueRange {
		return nil, "no usable sibling", false
	}
	gLo, gHi := gradeHigh(lineKey, lo, y), gradeHigh(lineKey, hi, y)
	if gLo.rank() < 0 || gLo != gHi {
		return nil, "no sibling decides it", false
	}
	high, low := gLo, mirror(gLo)
	outs := []oddinxml.Outcome{
		{ID: hiID, Result: high.res, VoidFactor: high.vf},
		{ID: loID, Result: low.res, VoidFactor: low.vf},
	}
	// Stable order (by id) so the apply-once payload hash is deterministic.
	if outs[0].ID > outs[1].ID {
		outs[0], outs[1] = outs[1], outs[0]
	}
	why := strings.Join(used, ",")
	if lo == hi {
		why = fmt.Sprintf("%s (value %d)", why, lo)
	} else {
		why = fmt.Sprintf("%s (value %d..%d)", why, lo, hi)
	}
	return outs, why, true
}

// siblingResult reads a settled sibling's outcomes ("id:result:void_factor,
// ...") and returns the HIGH side's result. Both sides must be present and
// mirror each other, or the sibling is not usable.
func siblingResult(results, hiID, loID string) (graded, bool) {
	res := map[string]string{}
	for _, part := range strings.Split(results, ",") {
		fields := strings.SplitN(part, ":", 3)
		if len(fields) < 2 {
			continue
		}
		res[fields[0]] = fields[1]
	}
	hi, okHi := fromStored(res[hiID])
	lo, okLo := fromStored(res[loID])
	if !okHi || !okLo || mirror(hi) != lo {
		return graded{}, false
	}
	return hi, true
}

// String renders the pass for the sweeper's log line.
func (st LadderStats) String() string {
	return fmt.Sprintf("candidates=%d settled=%d skipped=%v", st.Candidates, st.Settled, st.Skipped)
}
