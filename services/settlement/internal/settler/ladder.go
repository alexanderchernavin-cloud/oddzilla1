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
// What it does: a total and a handicap are monotonic in the line, so one
// settled sibling of the same family fixes the result of every line on one
// side of it. "Over 25.5 won" means the total was 26 or more, which settles
// "over 24.5" (won) but says nothing about "over 26.5". The inference is
// only ever a strict implication — a line the siblings do not decide is left
// exactly as it was, for the operator. Nothing here voids anything.
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

// LadderStats summarises one inference pass.
type LadderStats struct {
	Candidates int
	Settled    int
	Skipped    map[string]int
}

// ReconcileLadderLines settles every open total / handicap line on a closed
// Oddin match whose settled siblings strictly imply its result, through the
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
			// Provenance for the settlements audit row: which sibling
			// decided this line. Read by nothing, kept for the operator.
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
		s.log.Info().Str("event", ln.EventURN).Int("market", ln.ProviderMarketID).Str("specifiers", market.Specifiers).Str("from", why).Msg("ladder inference: settled from sibling")
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

// inferLine decides one open line from its settled siblings. It returns the
// settled outcomes in Oddin's wire form (result "1" won / "0" lost, no void
// factor) and the sibling that decided it, or a refusal reason.
//
// Only strict implications are accepted:
//
//	total, sibling X over-won  (T > X):  every Y < X is over-won
//	total, sibling X under-won (T < X):  every Y > X is under-won
//	total, sibling X pushed    (T = X):  Y < X over-won, Y > X under-won
//	handicap, sibling X home-won (M+X > 0): every Y > X is home-won
//	handicap, sibling X away-won (M+X < 0): every Y < X is away-won
//	handicap, sibling X pushed   (M = -X):  Y > X home-won, Y < X away-won
//
// where T is the total, M the home margin, both integers. The open line
// must be a whole or half line: a quarter line (2.25, -1.75) splits into
// two stakes and a strict inequality on the total does not make both halves
// win, so it is refused. Siblings settled half-won / half-lost (quarter
// lines themselves) carry no usable bound and are ignored. If two siblings
// disagree the data is inconsistent and the line is refused.
func inferLine(lineKey, openLine, outcomeIDs string, siblings []store.LadderSibling) ([]oddinxml.Outcome, string, bool) {
	y, err := strconv.ParseFloat(strings.TrimSpace(openLine), 64)
	if err != nil {
		return nil, "unreadable line", false
	}
	if twice := y * 2; math.Abs(twice-math.Round(twice)) > 1e-9 {
		return nil, "quarter line", false
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

	// verdict: +1 the high side wins at Y, -1 the low side wins at Y.
	verdict := 0
	decidedBy := ""
	for _, sib := range siblings {
		x, err := strconv.ParseFloat(strings.TrimSpace(sib.Line), 64)
		if err != nil {
			continue
		}
		bound, ok := siblingBound(sib.Results, hiID, loID)
		if !ok {
			continue
		}
		var v int
		switch {
		// Total: hi won at X means T > X. A total is a count, so the
		// statement "T > X" is "T >= next integer above X". Y < X is then
		// strictly below T: hi wins at Y. Handicap: hi won at X means
		// M + X > 0; Y > X gives M + Y > 0: hi wins at Y.
		case bound > 0 && lineKey == "threshold" && y < x,
			bound > 0 && lineKey == "handicap" && y > x:
			v = +1
		case bound < 0 && lineKey == "threshold" && y > x,
			bound < 0 && lineKey == "handicap" && y < x:
			v = -1
		// Push: the number IS X (total) or -X (handicap margin).
		case bound == 0 && lineKey == "threshold":
			if y < x {
				v = +1
			} else if y > x {
				v = -1
			}
		case bound == 0 && lineKey == "handicap":
			if y > x {
				v = +1
			} else if y < x {
				v = -1
			}
		}
		if v == 0 {
			continue
		}
		if verdict != 0 && verdict != v {
			return nil, "siblings disagree", false
		}
		if verdict == 0 {
			verdict = v
			decidedBy = lineKey + "=" + strings.TrimSpace(sib.Line)
		}
	}
	if verdict == 0 {
		return nil, "no sibling decides it", false
	}
	won, lost := hiID, loID
	if verdict < 0 {
		won, lost = loID, hiID
	}
	outs := []oddinxml.Outcome{{ID: hiID}, {ID: loID}}
	for i := range outs {
		if outs[i].ID == won {
			outs[i].Result = "1"
		} else if outs[i].ID == lost {
			outs[i].Result = "0"
		}
	}
	return outs, decidedBy, true
}

// siblingBound reads a settled sibling's outcomes ("id:result:void_factor,
// ...") and reports which side of its line the number fell: +1 the high
// side won, -1 the low side won, 0 a push (both void). Anything else — a
// half result, a missing outcome, a void on one side only — is not a bound.
func siblingBound(results, hiID, loID string) (int, bool) {
	res := map[string]string{}
	for _, part := range strings.Split(results, ",") {
		fields := strings.SplitN(part, ":", 3)
		if len(fields) < 2 {
			continue
		}
		res[fields[0]] = fields[1]
	}
	hi, lo := res[hiID], res[loID]
	switch {
	case hi == "won" && lo == "lost":
		return +1, true
	case hi == "lost" && lo == "won":
		return -1, true
	case hi == "void" && lo == "void":
		return 0, true
	}
	return 0, false
}

// String renders the pass for the sweeper's log line.
func (st LadderStats) String() string {
	return fmt.Sprintf("candidates=%d settled=%d skipped=%v", st.Candidates, st.Settled, st.Skipped)
}
