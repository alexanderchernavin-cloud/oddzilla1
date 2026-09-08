// Snapshot mapper: Fonbet events/list JSON → provider-agnostic matches,
// markets and outcomes shaped for the oddzilla schema. Pure functions, no
// I/O — the ingest package diffs consecutive snapshots and writes the
// deltas.
//
// Identity rules (see docs/FONBET.md):
//   match      → provider_urn "fb:match:<eventId>"
//   market     → provider_market_id = PMIDBase + catalogue table num
//                specifiers: handicap / threshold (line), map (esports
//                map N), variant (other sub-events), side (per-team tables)
//   outcome    → outcome_id = factor id, except match-winner tables which
//                use "1" (home) / "2" (away) / "3" (draw) so the list cards
//                can pair them like Oddin's.

package mapper

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/oddzilla/fonbet-ingester/internal/fonbet"
	"github.com/oddzilla/fonbet-ingester/internal/specifiers"
)

// provider_market_id namespaces. A cross-service contract, not a knob:
// services/api (FONBET_PMID_BASE) and the settlement grader hard-code the
// same values.
const (
	PMIDBase             = 1_000_000 // + Fonbet catalogue table number
	DoubleChancePMIDBase = 1_900_000 // 1X / 12 / X2 cells split off a match-winner table
)

// MarketTypeOf decodes a Fonbet provider_market_id back to the catalogue
// table it was built from, and whether it is the double-chance split.
//
// The ONE place that inverts the id scheme. The settlement grader used to
// do this arithmetic inline to reach `idx.Tables[n]` for the table name it
// grades on, which coupled a money path directly to how the id happens to
// be composed. It is a function so that when provider_market_id becomes a
// synthetic per-sub-event number — opaque, resolved through a registry —
// exactly one body changes and the grader does not.
func MarketTypeOf(pmid int) (tableNum int, doubleChance bool) {
	if pmid >= DoubleChancePMIDBase {
		return pmid - DoubleChancePMIDBase, true
	}
	return pmid - PMIDBase, false
}

type Options struct {
	BlockedSports    map[int]struct{}
	AllowedSports    map[int]struct{}
	IncludeSubEvents bool
	MaxMatches       int
	// Deny drops markets no grader can ever settle from the data we have
	// (fonbet_market_denylist, migration
	// 20260906T103343_settlement_operator_tools). nil = deny nothing.
	Deny *Denylist
}

// Denylist is the operator's list of market shapes to keep out of the
// offer: whole catalogue tables by Fonbet TABLE NUMBER ("winner of point N
// in a set", 7800) and sub-event families by the prefix of their label
// ("Player specials", "Special bets"). A denied market is never created;
// one that already exists is treated as gone by the ingest diff and
// deactivated (status 0), so it leaves the offer without being voided —
// settling it, if that ever becomes possible, stays the operator's call.
//
// Tables holds the TABLE number rather than a provider_market_id, and that
// is forced rather than cosmetic: a rule means "no grader can settle this
// table" and has always covered every sub-event of it, which a single
// provider_market_id cannot express now that each sub-event has its own
// (migration 20260908T115542).
type Denylist struct {
	Tables        map[int]struct{}
	LabelPrefixes []string
}

// Denies reports whether a market of this table with this sub-event label
// is on the list. Label matching is a case-insensitive prefix test.
func (d *Denylist) Denies(tableNum int, label string) bool {
	if d == nil {
		return false
	}
	if _, ok := d.Tables[tableNum]; ok {
		return true
	}
	if label == "" || len(d.LabelPrefixes) == 0 {
		return false
	}
	l := strings.ToLower(strings.TrimSpace(label))
	for _, p := range d.LabelPrefixes {
		if p != "" && strings.HasPrefix(l, strings.ToLower(strings.TrimSpace(p))) {
			return true
		}
	}
	return false
}

// Snapshot is one decoded line.
type Snapshot struct {
	PacketVersion int64
	Matches       []*Match       // live first, then by start time
	Skipped       map[string]int // reason → count, for the cycle log line
	// TotalMatches is the mappable match count BEFORE Options.MaxMatches
	// truncated Matches. The ingester's partial-snapshot guard compares
	// this, not len(Matches): with a cap set len(Matches) is pinned at the
	// cap and could never fall below half the previous cycle.
	TotalMatches int
	// Capped holds the event ids Options.MaxMatches cut off. They are still
	// on Fonbet's line; the ingester must not treat them as vanished.
	Capped map[int64]struct{}
}

type Match struct {
	EventID     int64
	SportID     int // Fonbet root sport id
	Sport       SportInfo
	SegmentID   int
	SegmentName string
	Category    string // derived from the segment name prefix ("Испания. Примера" → "Испания")
	Team1       string
	Team2       string
	Team1ID     int64
	Team2ID     int64
	StartTime   int64 // unix seconds
	Live        bool
	NotActive   bool
	Finished    bool
	Blocked     bool
	Score       *LiveScore
	Markets     map[string]*Market // keyed by Market.Key()
}

type LiveScore struct {
	Home    *int
	Away    *int
	Timer   string
	Comment string
	// Serve is which side is serving right now: 1 = team1 (home),
	// 2 = team2 (away), 0 = not applicable or not sent. Fonbet marks
	// it on the innermost score cell — the current game in tennis, the
	// current set in table tennis and volleyball — and repeats it as an
	// asterisk in the score comment ("15*-30" is team1 serving).
	Serve   int
	Periods []Period
}

type Period struct {
	Number int
	Title  string
	Home   string
	Away   string
}

type Market struct {
	PMID         int
	Specs        specifiers.Specifiers
	Canonical    string
	Hash         []byte
	Status       int16
	DoubleChance bool
	Variant      string // specs["variant"], "" for the main event
	VariantLabel string // human label of the sub-event ("1-й тайм", player name)
	Outcomes     map[string]*Outcome
}

func (m *Market) Key() string { return strconv.Itoa(m.PMID) + "|" + m.Canonical }

type Outcome struct {
	ID       string
	FactorID int
	Odds     string
	Active   bool
	Name     string // Fonbet caption with %P / %1 / %2 resolved; raw name for admin
}

// placeholderTeams are Fonbet's generic participants on aggregate
// specials ("any home team vs any away team of the round") — not matches.
var placeholderTeams = map[string]bool{
	"Хозяева": true, "Гости": true, "Home": true, "Away": true, "Хозяин": true, "Гость": true,
}

var mapRe = regexp.MustCompile(`(?i)^(?:(\d+)-?[яй]?\s*карта|map\s*(\d+)|(\d+)\s*карта)$`)

// Build maps one list response using the catalogue index.
func Build(resp *fonbet.ListResponse, idx *fonbet.Index, opt Options) *Snapshot {
	snap := &Snapshot{PacketVersion: resp.PacketVersion, Skipped: map[string]int{}}

	sports := make(map[int]*fonbet.Sport, len(resp.Sports))
	for i := range resp.Sports {
		sports[resp.Sports[i].ID] = &resp.Sports[i]
	}
	rootOf := func(segmentID int) *fonbet.Sport {
		s := sports[segmentID]
		for hops := 0; s != nil && s.ParentID != nil && hops < 8; hops++ {
			p := sports[*s.ParentID]
			if p == nil {
				break
			}
			s = p
		}
		return s
	}
	// One spelling per competition, decided once over the whole segment
	// list rather than per match — see canonicalCategories.
	canonicalCategory := canonicalCategories(sports)
	categoryOf := func(rootID int, segmentName string) string {
		name := categoryFromSegment(segmentName)
		if c, ok := canonicalCategory[categoryGroupKey(rootID, name)]; ok {
			return c
		}
		return name
	}

	factors := make(map[int64]map[int]fonbet.Factor, len(resp.CustomFactors))
	for _, cf := range resp.CustomFactors {
		m := make(map[int]fonbet.Factor, len(cf.Factors))
		for _, f := range cf.Factors {
			m[f.F] = f
		}
		factors[cf.EventID] = m
	}
	blockedAll := map[int64]bool{}
	blockedFactors := map[int64]map[int]bool{}
	for _, b := range resp.EventBlocks {
		switch b.State {
		case "blocked":
			blockedAll[b.EventID] = true
		case "partial":
			set := blockedFactors[b.EventID]
			if set == nil {
				set = map[int]bool{}
				blockedFactors[b.EventID] = set
			}
			for _, f := range b.Factors {
				set[f] = true
			}
		}
	}
	miscs := map[int64]*fonbet.EventMisc{}
	for i := range resp.EventMiscs {
		miscs[resp.EventMiscs[i].ID] = &resp.EventMiscs[i]
	}
	lives := map[int64]*fonbet.LiveEventInfo{}
	for i := range resp.LiveEventInfos {
		lives[resp.LiveEventInfos[i].EventID] = &resp.LiveEventInfos[i]
	}
	children := map[int64][]*fonbet.Event{}
	for i := range resp.Events {
		e := &resp.Events[i]
		if e.Level > 1 && e.ParentID != 0 {
			children[e.ParentID] = append(children[e.ParentID], e)
		}
	}

	for i := range resp.Events {
		e := &resp.Events[i]
		if e.Level != 1 {
			continue
		}
		if e.Place != "line" && e.Place != "live" && e.Place != "notActive" {
			snap.Skipped["place:"+e.Place]++
			continue
		}
		if strings.TrimSpace(e.Team1) == "" || strings.TrimSpace(e.Team2) == "" {
			snap.Skipped["no_teams"]++ // outrights / specials have a single participant
			continue
		}
		if placeholderTeams[strings.TrimSpace(e.Team1)] || placeholderTeams[strings.TrimSpace(e.Team2)] {
			snap.Skipped["placeholder_teams"]++ // "Хозяева — Гости" aggregate specials
			continue
		}
		root := rootOf(e.SportID)
		if root == nil {
			snap.Skipped["no_sport"]++
			continue
		}
		if _, blocked := opt.BlockedSports[root.ID]; blocked {
			snap.Skipped["blocked_sport"]++
			continue
		}
		if len(opt.AllowedSports) > 0 {
			if _, ok := opt.AllowedSports[root.ID]; !ok {
				snap.Skipped["not_allowed_sport"]++
				continue
			}
		}
		seg := sports[e.SportID]
		segName := ""
		if seg != nil {
			segName = strings.TrimSpace(seg.Name)
		}
		m := &Match{
			EventID:     e.ID,
			SportID:     root.ID,
			Sport:       SportFor(root.ID, root.Name),
			SegmentID:   e.SportID,
			SegmentName: segName,
			Category:    categoryOf(root.ID, segName),
			Team1:       strings.TrimSpace(e.Team1),
			Team2:       strings.TrimSpace(e.Team2),
			Team1ID:     e.Team1ID,
			Team2ID:     e.Team2ID,
			StartTime:   e.StartTime,
			Live:        e.Place == "live",
			NotActive:   e.Place == "notActive",
			Blocked:     blockedAll[e.ID],
			Markets:     map[string]*Market{},
		}
		if li := lives[e.ID]; li != nil && li.Finished {
			m.Finished = true
		}
		if m.Live {
			m.Score = buildScore(miscs[e.ID], lives[e.ID])
		}

		suspendAll := m.Blocked || m.NotActive
		addFactors(m, idx, factors[e.ID], blockedFactors[e.ID], suspendAll, nil, "")

		if opt.IncludeSubEvents {
			// Walk the sub-event tree (halves → half corners, players under a
			// "players" node, ...). A nested child inherits its parent's
			// label and variant so "угловые" under "1-й тайм" becomes
			// "1-й тайм угловые" / variant "fb:100201/400100" — distinct from
			// full-match corners in the catalog and graded on the half's
			// statistic row at settlement.
			type node struct {
				ev            *fonbet.Event
				parentVariant string
				parentLabel   string
			}
			queue := make([]node, 0, len(children[e.ID]))
			for _, c := range children[e.ID] {
				queue = append(queue, node{ev: c})
			}
			for len(queue) > 0 {
				n := queue[0]
				queue = queue[1:]
				base, label := subEventSpecs(n.ev, n.parentVariant, n.parentLabel)
				if label == "" {
					continue
				}
				for _, gc := range children[n.ev.ID] {
					queue = append(queue, node{ev: gc, parentVariant: base["variant"], parentLabel: label})
				}
				addFactors(m, idx, factors[n.ev.ID], blockedFactors[n.ev.ID], suspendAll || blockedAll[n.ev.ID], base, label)
			}
		}
		// Operator denylist: shapes no grader can settle are not offered.
		// Applied after the whole tree is built so a denied sub-event
		// family is dropped wherever it was nested.
		if opt.Deny != nil {
			for key, mk := range m.Markets {
				tableNum, _ := MarketTypeOf(mk.PMID)
				if opt.Deny.Denies(tableNum, mk.VariantLabel) {
					delete(m.Markets, key)
					snap.Skipped["denylisted_markets"]++
				}
			}
		}
		// A live match can legitimately carry zero priced factors for a
		// while (Fonbet blocks the whole event around goals / VAR). Keep it
		// so the ingester suspends its markets instead of closing the match
		// as "vanished". Prematch events without any price are noise.
		if len(m.Markets) == 0 && !m.Live {
			snap.Skipped["no_markets"]++
			continue
		}
		snap.Matches = append(snap.Matches, m)
	}

	sort.SliceStable(snap.Matches, func(i, j int) bool {
		a, b := snap.Matches[i], snap.Matches[j]
		if a.Live != b.Live {
			return a.Live
		}
		if a.StartTime != b.StartTime {
			return a.StartTime < b.StartTime
		}
		return a.EventID < b.EventID
	})
	snap.TotalMatches = len(snap.Matches)
	if opt.MaxMatches > 0 && len(snap.Matches) > opt.MaxMatches {
		snap.Skipped["max_matches"] += len(snap.Matches) - opt.MaxMatches
		snap.Capped = make(map[int64]struct{}, len(snap.Matches)-opt.MaxMatches)
		for _, m := range snap.Matches[opt.MaxMatches:] {
			snap.Capped[m.EventID] = struct{}{}
		}
		snap.Matches = snap.Matches[:opt.MaxMatches]
	}
	return snap
}

// subEventSpecs derives the extra specifiers for a level-2/3 event. Maps
// (esports) become `map=N` so the storefront renders them as Map N tabs;
// everything else becomes a `variant` so its markets never collide with
// the main event's and pick up their own description rows.
func subEventSpecs(c *fonbet.Event, parentVariant, parentLabel string) (specifiers.Specifiers, string) {
	name := strings.TrimSpace(c.Name)
	if name == "" {
		name = strings.TrimSpace(c.Team1) // player props (kind 91) carry the player in team1
	}
	if name == "" {
		return nil, ""
	}
	if parentVariant == "" {
		if m := mapRe.FindStringSubmatch(name); m != nil {
			n := firstNonEmpty(m[1:]...)
			if n != "" {
				return specifiers.Specifiers{"map": n}, name
			}
		}
	}
	// Nested child: fold the parent in unless Fonbet already spelled it
	// out in the child's own name ("1-й тайм угловые").
	if parentLabel != "" && !strings.Contains(strings.ToLower(name), strings.ToLower(parentLabel)) {
		name = parentLabel + " " + name
	}
	v := strconv.FormatInt(c.Kind, 10)
	if strings.TrimSpace(c.Name) == "" && c.Team1ID != 0 {
		v += ":" + strconv.FormatInt(c.Team1ID, 10)
	}
	if parentVariant != "" {
		v = strings.TrimPrefix(parentVariant, "fb:") + "/" + v
	}
	return specifiers.Specifiers{"variant": "fb:" + v}, name
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

func addFactors(
	m *Match,
	idx *fonbet.Index,
	fs map[int]fonbet.Factor,
	blocked map[int]bool,
	suspendAll bool,
	base specifiers.Specifiers,
	variantLabel string,
) {
	if len(fs) == 0 {
		return
	}
	// Deterministic iteration: sort factor ids so the first-present factor
	// of a line is stable between cycles.
	ids := make([]int, 0, len(fs))
	for id := range fs {
		ids = append(ids, id)
	}
	sort.Ints(ids)

	for _, id := range ids {
		f := fs[id]
		meta := idx.Factors[id]
		if meta == nil || f.V <= 1.0 || math.IsNaN(f.V) || math.IsInf(f.V, 0) {
			continue
		}
		t := meta.Table
		specs := specifiers.Specifiers{}
		for k, v := range base {
			specs[k] = v
		}
		if t.Side != "" {
			specs["side"] = t.Side
		}
		line := ""
		if t.Param != fonbet.ParamNone {
			line = lineFor(meta, fs)
			if line == "" {
				continue
			}
			specs[t.Param.SpecifierKey()] = line
		}
		// Match-winner handling (canonical 1/2/3 outcome ids + the
		// double-chance split) applies to the main event only. A half /
		// period / map "1X2" keeps factor ids so the storefront's
		// match-winner lookup (outcome ids 1/2/3 in the Fonbet pmid range)
		// can never pick a sub-event market for the list card.
		mainEvent := len(base) == 0
		pmid := PMIDBase + t.Num
		if meta.DoubleChance && mainEvent {
			pmid = DoubleChancePMIDBase + t.Num
		}
		canonical := specifiers.Canonical(specs)
		key := strconv.Itoa(pmid) + "|" + canonical
		mk := m.Markets[key]
		if mk == nil {
			status := int16(1)
			if suspendAll {
				status = -1
			}
			mk = &Market{
				PMID:         pmid,
				Specs:        specs,
				Canonical:    canonical,
				Hash:         specifiers.Hash(specs),
				Status:       status,
				DoubleChance: meta.DoubleChance && mainEvent,
				Variant:      specs["variant"],
				VariantLabel: variantLabel,
				Outcomes:     map[string]*Outcome{},
			}
			m.Markets[key] = mk
		}
		outcomeID := strconv.Itoa(id)
		switch {
		case meta.WinnerOutcome != "" && mainEvent:
			outcomeID = meta.WinnerOutcome
		case meta.SideID != "":
			outcomeID = meta.SideID // line markets: one outcome per side, whichever row prices it
		}
		if _, dup := mk.Outcomes[outcomeID]; dup {
			continue
		}
		mk.Outcomes[outcomeID] = &Outcome{
			ID:       outcomeID,
			FactorID: id,
			Odds:     FormatOdds(f.V),
			Active:   !suspendAll && !blocked[id],
			Name:     resolveCaption(meta.Label, f, m.Team1, m.Team2),
		}
	}
}

// lineFor picks the line value for a parameterised factor: the display
// parameter of side 1 (the first value cell on the same catalogue row), so
// both sides of one line share a specifier. When Fonbet withholds side 1
// (odds pruned) the line is derived from side 2 by flipping its sign, so
// the stored handicap is always the home-applied value.
func lineFor(meta *fonbet.FactorMeta, fs map[int]fonbet.Factor) string {
	row := meta.RowFactors()
	if len(row) == 0 {
		return NormalizeParam(fs[meta.FactorID])
	}
	if f, ok := fs[row[0]]; ok {
		if v := NormalizeParam(f); v != "" {
			return v
		}
	}
	for i, rf := range row {
		f, ok := fs[rf]
		if !ok {
			continue
		}
		v := NormalizeParam(f)
		if v == "" {
			continue
		}
		if meta.Table.Param == fonbet.ParamHandicap && i > 0 {
			return negateLine(v)
		}
		return v
	}
	return ""
}

// negateLine flips the sign of a numeric line ("2.5" ↔ "-2.5", "0" stays).
func negateLine(v string) string {
	if v == "0" || v == "" {
		return v
	}
	if strings.HasPrefix(v, "-") {
		return v[1:]
	}
	if _, err := strconv.ParseFloat(v, 64); err != nil {
		return v // non-numeric parameter: leave as-is
	}
	return "-" + v
}

// NormalizeParam turns Fonbet's display parameter into a specifier value:
// "+2.5" → "2.5", "-0" → "0"; falls back to p/100 when pt is missing.
func NormalizeParam(f fonbet.Factor) string {
	pt := strings.TrimSpace(f.PT)
	if pt == "" && f.P != nil {
		pt = strconv.FormatFloat(float64(*f.P)/100, 'f', -1, 64)
	}
	pt = strings.TrimPrefix(pt, "+")
	if pt == "-0" || pt == "-0.0" {
		pt = "0"
	}
	return specifiers.SafeValue(pt)
}

// FormatOdds renders a decimal price with at most 4 fractional digits and
// no trailing zeros (numeric(10,4) in market_outcomes).
func FormatOdds(v float64) string {
	r := math.Round(v*10000) / 10000
	return strconv.FormatFloat(r, 'f', -1, 64)
}

func resolveCaption(label string, f fonbet.Factor, team1, team2 string) string {
	s := label
	if strings.Contains(s, "%P") {
		s = strings.ReplaceAll(s, "%P", strings.TrimSpace(f.PT))
	}
	s = strings.ReplaceAll(s, "%1", team1)
	s = strings.ReplaceAll(s, "%2", team2)
	if f.PT != "" && !strings.Contains(label, "%P") {
		s = s + " " + strings.TrimSpace(f.PT)
	}
	return strings.TrimSpace(s)
}

// categoryFromSegment derives a category label from a Fonbet league name.
// Names are dotted paths ("Spain. Primera Division. Season 26/27"), so the
// first segment is the country / discipline; a single-segment name has no
// natural parent and lands under "Other".
func categoryFromSegment(name string) string {
	if i := strings.Index(name, ". "); i > 0 {
		return strings.TrimSpace(name[:i])
	}
	return CategoryOther
}

// CategoryOther is where a single-segment league name lands: it names no
// parent, so there is nothing to group it under.
const CategoryOther = "Other"

// categoryKey is the identity of a category, as opposed to its spelling.
//
// Fonbet has no category ids — the category is a prefix of a league name —
// so the same competition splits into two buckets whenever Fonbet writes
// that prefix two ways, and it does. Measured across the whole live line
// on 2026-09-07, four competitions were spelled two ways and three of
// them had bookable matches under BOTH spellings:
//
//	Football     "UEFA Champions League" / "Champions League UEFA"
//	Cricket      "National teams"        / "National Teams"
//	Hockey       "Short-hockey"          / "Short Hockey"
//	Racing       "Formula-1"             / "Formula 1"
//
// Word order, letter case, a hyphen. So the key folds all three away:
// lowercase, punctuation to spaces, tokens sorted. Every one of those
// pairs collapses onto one key and every other name in the line keeps a
// key of its own.
//
// Fonbet's tree cannot answer this instead — checked before writing this:
// all 12 Champions League segments have the ROOT SPORT as their parent
// (`parentId: 1`), so there is no intermediate node to read a category
// from. The string is all there is.
//
// Sorting tokens is the aggressive part, and its risk is merging two
// names that are genuine permutations of each other with different
// meanings ("Cup League" vs "League Cup"). Nothing in the live line does
// that, and a category name is a country or a competition, where a
// reordering is the same thing said differently. The narrower rule —
// case and punctuation only — would leave the Champions League split,
// which is the case that was reported.
func categoryKey(name string) string {
	var b strings.Builder
	b.Grow(len(name))
	for _, r := range strings.ToLower(name) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		} else {
			b.WriteRune(' ')
		}
	}
	tokens := strings.Fields(b.String())
	sort.Strings(tokens)
	return strings.Join(tokens, " ")
}

// categoryGroupKey scopes a spelling key to its root sport. A category row
// is `(sport_id, slug)`, so the decision has to be made per sport too:
// "National teams" exists under cricket, football AND volleyball, and the
// spelling chosen for one must neither depend on nor move another's.
func categoryGroupKey(rootID int, name string) string {
	return strconv.Itoa(rootID) + "|" + categoryKey(name)
}

// innerDotRe finds a "." glued to the next word — the separator Fonbet
// dropped in "Bolivia.League Cup. Group stage".
var innerDotRe = regexp.MustCompile(`\.\pL`)

// canonicalCategories resolves each category spelling in a snapshot to the
// one spelling its whole group is filed under, per root sport.
//
// The winner is the spelling on the LOWEST Fonbet segment id in the group.
// The rule has to be stable above all else: the chosen name is what
// `Slugify` turns into `categories.slug`, which is the row's identity, so
// a name that flapped between cycles would keep minting new category rows
// and stranding the operator's pin and hidden flag on the old one. A
// segment id is a permanent Fonbet id, so the answer only moves if that
// exact segment leaves the line — where a "spelling used by the most
// segments" rule would move whenever Fonbet added one, and ties on the
// football group anyway (6 segments each).
//
// It also happens to pick the name the operator had already pinned:
// segment 63304 "UEFA Champions League. Top scorer" is the oldest of the
// twelve, so the merged bucket is "UEFA Champions League" — category 6737
// on production, pinned first in Football's tree — rather than the
// unpinned "Champions League UEFA" beside it.
//
// A second pass re-homes a DROPPED SEPARATOR. "Bolivia.League Cup. Group
// stage" has no ". " until after "Cup", so the first segment comes out as
// "Bolivia.League Cup" — a bucket of its own, with no flag, directly under
// "Bolivia" (production category 8293 beside 6645, 2026-09-07). Splitting on
// every "." would be wrong: "Cup of Belov-Kondrashin. St.Petersburg" and
// "Legends Cup named V.I. Savvin" carry a period INSIDE a word. So the
// inner dot is honoured only when the text before it is already a category
// of the same sport — "Bolivia" is, "St" is not — which is exactly the
// evidence that a separator went missing rather than a name having a dot
// in it. Measured on the live line: one segment qualifies, the two
// look-alikes have their dot in a LATER segment and never reach this code.
//
// The limit worth stating: this folds away case, punctuation, word order
// and a dropped separator, and nothing else. A genuine typo, or the same
// competition named in two languages, still splits, and there is no
// operator-facing merge to fall back on yet.
func canonicalCategories(sports map[int]*fonbet.Sport) map[string]string {
	rootOf := func(id int) int {
		s := sports[id]
		for hops := 0; s != nil && s.ParentID != nil && hops < 8; hops++ {
			p := sports[*s.ParentID]
			if p == nil {
				break
			}
			s = p
		}
		if s == nil {
			return id
		}
		return s.ID
	}
	type pick struct {
		name      string
		segmentID int
	}
	type seg struct {
		id   int
		root int
		name string // first segment, as Fonbet spelled it
	}
	// Deterministic iteration: a Go map is randomly ordered, and reading
	// segments in a different order each cycle would let two spellings
	// sharing the lowest id trade the group between them.
	ids := make([]int, 0, len(sports))
	for id := range sports {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	best := map[string]pick{}
	segs := make([]seg, 0, len(ids))
	for _, id := range ids {
		s := sports[id]
		if s == nil {
			continue
		}
		name := categoryFromSegment(strings.TrimSpace(s.Name))
		if name == CategoryOther || categoryKey(name) == "" {
			continue
		}
		root := rootOf(id)
		segs = append(segs, seg{id: id, root: root, name: name})
		k := categoryGroupKey(root, name)
		if cur, ok := best[k]; !ok || id < cur.segmentID {
			best[k] = pick{name: name, segmentID: id}
		}
	}
	out := make(map[string]string, len(best))
	for k, p := range best {
		out[k] = p.name
	}
	// Dropped separators, now that every real category of the sport is
	// known. Left to right, first head that is one wins.
	for _, sg := range segs {
		for _, m := range innerDotRe.FindAllStringIndex(sg.name, -1) {
			head := strings.TrimSpace(sg.name[:m[0]])
			if head == "" {
				continue
			}
			hk := categoryGroupKey(sg.root, head)
			if home, ok := best[hk]; ok {
				out[categoryGroupKey(sg.root, sg.name)] = home.name
				break
			}
		}
	}
	return out
}

func buildScore(mi *fonbet.EventMisc, li *fonbet.LiveEventInfo) *LiveScore {
	if mi == nil && li == nil {
		return nil
	}
	s := &LiveScore{}
	if mi != nil {
		s.Home, s.Away = mi.Score1, mi.Score2
		s.Comment = strings.TrimSpace(mi.Comment)
	}
	if li != nil {
		s.Timer = li.Timer
		if s.Comment == "" {
			s.Comment = strings.TrimSpace(li.ScoreComment)
		}
		// scores[0] = overall, scores[1..] = periods (sets, halves, maps).
		// Serve rides the innermost cell, whichever group that turns out
		// to be (group 2 "game" in tennis, group 1 "set" in table tennis
		// and volleyball), so take the last one that carries it rather
		// than hard-coding a group index per sport. Values other than
		// 1 / 2 are dropped — the storefront reads it as a side.
		for gi := 1; gi < len(li.Scores); gi++ {
			for _, c := range li.Scores[gi] {
				if c.Serve != nil && (*c.Serve == 1 || *c.Serve == 2) {
					s.Serve = *c.Serve
				}
				s.Periods = append(s.Periods, Period{Number: len(s.Periods) + 1, Title: c.Title, Home: c.C1, Away: c.C2})
			}
		}
		if s.Home == nil && len(li.Scores) > 0 && len(li.Scores[0]) > 0 {
			if h, err := strconv.Atoi(li.Scores[0][0].C1); err == nil {
				s.Home = &h
			}
			if a, err := strconv.Atoi(li.Scores[0][0].C2); err == nil {
				s.Away = &a
			}
		}
	}
	if s.Home == nil && s.Away == nil && s.Timer == "" && len(s.Periods) == 0 {
		return nil
	}
	return s
}
