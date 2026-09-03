// Bifrost match snapshot → Oddin-shaped XML.
//
// The whole point of this package is that feed-ingester and settlement do
// not know the backup exists: they receive `odds_change` and
// `bet_settlement` documents byte-compatible with what Oddin's AMQP broker
// sends, so every invariant they enforce (specifier canonicalisation,
// sticky terminal market status, apply-once settlement, the full-outcome-
// set diff) applies unchanged. Nothing here touches Postgres or Redis; the
// functions are pure and unit-tested against the same encoding/xml
// structs the consumers decode with.
//
// Mapping (see docs/BIFROST_BACKUP_FEED.md for the evidence behind each):
//
//	match state   NOT_STARTED / STARTED / CLOSED     → sport_event_status status 0 / 1 / 4
//	market state  OPEN / SUSPENDED                  → market status 1 / -1
//	market state  CLOSED                            → excluded from odds_change; candidate for bet_settlement
//	outcome       OPEN                              → active=1 with odds
//	outcome       SUSPENDED / INACTIVE / terminal   → active=0 (never offer what Bifrost will not take)
//	outcome       WON / LOST                        → result 1 / 0
//	outcome       HALF_WON / HALF_LOST              → result 1 / 0, void_factor 0.5
//	outcome       VOIDED                            → result 0, void_factor 1 (refund)
//	probabilities                                   → 1/odds normalised by the market overround
//	simpleScore   periods                           → period_scores (+ scoreboard for the live period)

package translate

import (
	"encoding/xml"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/oddzilla/bifrost-feed/internal/bifrost"
)

// Family decides which per-period counters a sport's scores populate.
type Family int

const (
	FamilyGeneric Family = iota
	FamilyRounds         // CS2, Valorant, Rainbow Six: period score = rounds won
	FamilyKills          // Dota 2, LoL, King of Glory, MLBB, AoV: period score = kills
	FamilyGoals          // eFootball, FIFA: period score = goals
)

// FamilyForSport classifies by Oddin sport URN. Unknown sports are generic
// (home_score / away_score only), which still renders as a scoreline.
func FamilyForSport(sportURN string) Family {
	switch sportURN {
	case "od:sport:3", "od:sport:21", "od:sport:13", "od:sport:16", "od:sport:46":
		return FamilyRounds
	case "od:sport:2", "od:sport:39", "od:sport:1", "od:sport:10", "od:sport:31", "od:sport:29", "od:sport:28", "od:sport:40":
		return FamilyKills
	case "od:sport:19", "od:sport:6":
		return FamilyGoals
	}
	return FamilyGeneric
}

// MatchStatusCode maps a Bifrost match state to Oddin's sport_event_status
// code (0 not_started, 1 live, 4 closed). Unknown states return -1 so the
// caller can omit the block rather than assert a lifecycle it cannot see.
func MatchStatusCode(state string) int {
	switch state {
	case bifrost.MatchNotStarted:
		return 0
	case bifrost.MatchStarted:
		return 1
	case bifrost.MatchClosed:
		return 4
	}
	return -1
}

// Product picks the Oddin producer id the message claims to come from:
// 1 pre-match, 2 live. feed-ingester keeps one recovery cursor per producer.
func Product(state string) int {
	if state == bifrost.MatchNotStarted {
		return 1
	}
	return 2
}

// ─── XML shapes (mirror services/*/internal/oddinxml/messages.go) ─────────

type oddsChangeXML struct {
	XMLName          xml.Name             `xml:"odds_change"`
	EventID          string               `xml:"event_id,attr"`
	Product          int                  `xml:"product,attr"`
	Timestamp        int64                `xml:"timestamp,attr"`
	SportEventStatus *sportEventStatusXML `xml:"sport_event_status,omitempty"`
	Odds             *oddsBlockXML        `xml:"odds,omitempty"`
}

type sportEventStatusXML struct {
	Status       int              `xml:"status,attr"`
	HomeScore    *int             `xml:"home_score,attr,omitempty"`
	AwayScore    *int             `xml:"away_score,attr,omitempty"`
	PeriodScores *periodScoresXML `xml:"period_scores,omitempty"`
	Scoreboard   *scoreboardXML   `xml:"scoreboard,omitempty"`
}

type periodScoresXML struct {
	Periods []periodScoreXML `xml:"period_score"`
}

type periodScoreXML struct {
	Number          int    `xml:"number,attr"`
	Type            string `xml:"type,attr,omitempty"`
	MatchStatusCode *int   `xml:"match_status_code,attr,omitempty"`
	HomeScore       int    `xml:"home_score,attr"`
	AwayScore       int    `xml:"away_score,attr"`
	HomeWonRounds   *int   `xml:"home_won_rounds,attr,omitempty"`
	AwayWonRounds   *int   `xml:"away_won_rounds,attr,omitempty"`
	HomeKills       *int   `xml:"home_kills,attr,omitempty"`
	AwayKills       *int   `xml:"away_kills,attr,omitempty"`
	HomeGoals       *int   `xml:"home_goals,attr,omitempty"`
	AwayGoals       *int   `xml:"away_goals,attr,omitempty"`
}

type scoreboardXML struct {
	HomeWonRounds *int `xml:"home_won_rounds,attr,omitempty"`
	AwayWonRounds *int `xml:"away_won_rounds,attr,omitempty"`
	HomeKills     *int `xml:"home_kills,attr,omitempty"`
	AwayKills     *int `xml:"away_kills,attr,omitempty"`
	HomeGoals     *int `xml:"home_goals,attr,omitempty"`
	AwayGoals     *int `xml:"away_goals,attr,omitempty"`
}

type oddsBlockXML struct {
	Markets []marketXML `xml:"market"`
}

// marketXML carries one attribute Oddin's own odds_change never does:
// `name`, the rendered market group name from Bifrost ("Handicap",
// "Map Duration"). feed-ingester seeds market_descriptions from it when no
// REST-sourced template exists, so a market type first seen while the
// feed source is Backup still gets a label. Oddin's decoder side ignores
// unknown attributes, and ours only acts when the value is present.
type marketXML struct {
	ID         int          `xml:"id,attr"`
	Specifiers string       `xml:"specifiers,attr,omitempty"`
	Status     int          `xml:"status,attr"`
	Name       string       `xml:"name,attr,omitempty"`
	Outcomes   []outcomeXML `xml:"outcome"`
}

// outcomeXML.Name is a real Oddin attribute (their player-prop outcomes
// carry it); we fill it from Bifrost's selection names for every outcome
// so market_outcomes.name is populated and the storefront's label fallback
// has something better than the raw id.
type outcomeXML struct {
	ID            string `xml:"id,attr"`
	Odds          string `xml:"odds,attr,omitempty"`
	Active        int    `xml:"active,attr"`
	Probabilities string `xml:"probabilities,attr,omitempty"`
	Name          string `xml:"name,attr,omitempty"`
}

type betSettlementXML struct {
	XMLName   xml.Name             `xml:"bet_settlement"`
	EventID   string               `xml:"event_id,attr"`
	Product   int                  `xml:"product,attr"`
	Timestamp int64                `xml:"timestamp,attr"`
	Certainty int                  `xml:"certainty,attr"`
	Outcomes  settlementMarketsXML `xml:"outcomes"`
}

type settlementMarketsXML struct {
	Markets []settleMarketXML `xml:"market"`
}

type settleMarketXML struct {
	ID         int                `xml:"id,attr"`
	Specifiers string             `xml:"specifiers,attr,omitempty"`
	Outcomes   []settleOutcomeXML `xml:"outcome"`
}

type settleOutcomeXML struct {
	ID         string `xml:"id,attr"`
	Result     string `xml:"result,attr"`
	VoidFactor string `xml:"void_factor,attr,omitempty"`
}

// ─── odds_change ───────────────────────────────────────────────────────────

// OddsChange renders the non-settled markets of a snapshot as one Oddin
// odds_change. Returns (nil, nil) when the match carries no open or
// suspended market — feed-ingester ignores an odds_change with no markets,
// and a match whose every market is CLOSED belongs to the settlement path.
func OddsChange(m *bifrost.Match, nowMs int64) ([]byte, error) {
	urn := m.URN()
	if urn == "" {
		return nil, fmt.Errorf("match %q: no urn", m.ID)
	}
	markets := collectMarkets(m)
	var out []marketXML
	for _, mk := range markets {
		if mk.market.State == bifrost.MarketClosed {
			continue
		}
		out = append(out, renderMarket(mk))
	}
	if len(out) == 0 {
		return nil, nil
	}
	doc := oddsChangeXML{
		EventID:          urn,
		Product:          Product(m.State),
		Timestamp:        nowMs,
		SportEventStatus: sportEventStatus(m),
		Odds:             &oddsBlockXML{Markets: out},
	}
	return marshal(doc)
}

// keyedMarket pairs a Bifrost market with the Oddzilla key recovered from
// its id. Markets whose id fails to decode are dropped with the reason.
type keyedMarket struct {
	key    bifrost.MarketKey
	market bifrost.Market
	// name is the market group's rendered name ("Handicap"); the scope
	// prefix ("Map 2") is deliberately left off because feed-ingester
	// derives scope from the specifiers.
	name string
	// outcomes in wire order with their Oddin ids
	outcomes []keyedOutcome
}

type keyedOutcome struct {
	id      string
	outcome bifrost.Outcome
	// name is the group's selection name for this outcome id ("PuckChamp",
	// "under", "2:0"); empty when the group listed no matching selection.
	name string
}

// collectMarkets flattens marketGroups → markets, deduplicating by key
// (Bifrost repeats the main markets inside mainMarketGroups; we read only
// marketGroups, which is the complete list, and still guard against a
// duplicate id).
func collectMarkets(m *bifrost.Match) []keyedMarket {
	seen := make(map[bifrost.MarketKey]struct{})
	var out []keyedMarket
	for _, g := range m.MarketGroups {
		selNames := selectionNames(g)
		for _, mk := range g.Markets {
			_, key, err := bifrost.ParseMarketID(mk.ID)
			if err != nil {
				continue
			}
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			km := keyedMarket{key: key, market: mk, name: strings.TrimSpace(g.Name)}
			for _, o := range mk.Outcomes {
				_, _, oid, err := bifrost.ParseOutcomeID(o.ID)
				if err != nil || oid == "" {
					continue
				}
				km.outcomes = append(km.outcomes, keyedOutcome{id: oid, outcome: o, name: selNames[oid]})
			}
			out = append(out, km)
		}
	}
	// Stable order so two renders of the same snapshot are byte-identical.
	sort.Slice(out, func(i, j int) bool {
		if out[i].key.ProviderMarketID != out[j].key.ProviderMarketID {
			return out[i].key.ProviderMarketID < out[j].key.ProviderMarketID
		}
		return out[i].key.Specifiers < out[j].key.Specifiers
	})
	return out
}

// selectionNames maps Oddin outcome id → rendered selection name for one
// market group. Selection ids decode to
// market_group_selection/<urn>/<group key>/<outcome id>; the last segment
// is the same outcome id the group's markets use.
func selectionNames(g bifrost.MarketGroup) map[string]string {
	out := make(map[string]string, len(g.Selections))
	for _, s := range g.Selections {
		name := strings.TrimSpace(s.Name)
		if name == "" {
			continue
		}
		_, path, err := bifrost.DecodeID(s.ID)
		if err != nil || len(path) == 0 {
			continue
		}
		out[path[len(path)-1]] = name
	}
	return out
}

func renderMarket(km keyedMarket) marketXML {
	status := -1
	if km.market.State == bifrost.MarketOpen {
		status = 1
	}
	probs := Probabilities(km.outcomes)
	outs := make([]outcomeXML, 0, len(km.outcomes))
	for i, ko := range km.outcomes {
		o := outcomeXML{ID: ko.id, Name: ko.name}
		if ko.outcome.Odds != nil {
			o.Odds = FormatOdds(*ko.outcome.Odds)
		}
		if ko.outcome.Status == bifrost.OutcomeOpen {
			o.Active = 1
		}
		if p, ok := probs[i]; ok {
			o.Probabilities = p
		}
		outs = append(outs, o)
	}
	return marketXML{
		ID:         km.key.ProviderMarketID,
		Specifiers: km.key.Specifiers,
		Status:     status,
		Name:       km.name,
		Outcomes:   outs,
	}
}

// Probabilities derives margin-free implied probabilities for a market:
// 1/odds for every quotable outcome, divided by their sum so the book adds
// to one. Oddin's own `probabilities` attribute is exactly this quantity
// (a 1.95 / 1.78 two-way book carried 0.48 / 0.52 on the real feed, which
// this reproduces to two decimals). Returns index → formatted value; empty
// when fewer than two outcomes carry a usable price, since a single-runner
// normalisation would always be 1.0 and say nothing.
func Probabilities(outcomes []keyedOutcome) map[int]string {
	out := make(map[int]string)
	sum := 0.0
	n := 0
	for _, ko := range outcomes {
		if quotable(ko.outcome) {
			sum += 1 / *ko.outcome.Odds
			n++
		}
	}
	if n < 2 || sum <= 0 {
		return out
	}
	for i, ko := range outcomes {
		if !quotable(ko.outcome) {
			continue
		}
		p := (1 / *ko.outcome.Odds) / sum
		if p <= 0 || p >= 1 || math.IsNaN(p) {
			continue
		}
		out[i] = trimZeros(strconv.FormatFloat(p, 'f', 4, 64))
	}
	return out
}

// quotable is "has a price a bettor could take": odds above 1.0 on an
// outcome Bifrost is still offering or merely pausing. Terminal and
// inactive outcomes keep no price and are excluded from the book.
func quotable(o bifrost.Outcome) bool {
	if o.Odds == nil || *o.Odds <= 1 || math.IsInf(*o.Odds, 0) || math.IsNaN(*o.Odds) {
		return false
	}
	return o.Status == bifrost.OutcomeOpen || o.Status == bifrost.OutcomeSuspended
}

// FormatOdds renders a price the way Oddin's XML carries it: shortest
// decimal that round-trips (7 → "7", 1.03 → "1.03", 5.3 → "5.3"). The
// consumers store it in NUMERIC(10,4).
func FormatOdds(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

func trimZeros(s string) string {
	if !strings.Contains(s, ".") {
		return s
	}
	s = strings.TrimRight(s, "0")
	return strings.TrimSuffix(s, ".")
}

// sportEventStatus renders lifecycle + score. Always present when the
// state is known: the lifecycle code is what moves matches.status.
func sportEventStatus(m *bifrost.Match) *sportEventStatusXML {
	code := MatchStatusCode(m.State)
	if code < 0 {
		return nil
	}
	ses := &sportEventStatusXML{Status: code}
	s := m.SimpleScore
	if s == nil {
		return ses
	}
	if h, ok := atoi(s.Home); ok {
		if a, ok := atoi(s.Away); ok {
			ses.HomeScore, ses.AwayScore = &h, &a
		}
	}
	if len(s.Periods) == 0 {
		return ses
	}
	family := FamilyGeneric
	if m.Tournament != nil && m.Tournament.Sport != nil {
		family = FamilyForSport(m.Tournament.Sport.URN())
	}
	periodType := strings.ToLower(s.PeriodType)
	live := -1
	if m.State == bifrost.MatchStarted && s.ActivePeriodIdx != nil && *s.ActivePeriodIdx >= 0 && *s.ActivePeriodIdx < len(s.Periods) {
		live = *s.ActivePeriodIdx
	}
	ps := &periodScoresXML{}
	for i, p := range s.Periods {
		h, okH := atoi(p.Home)
		a, okA := atoi(p.Away)
		if !okH || !okA {
			continue
		}
		row := periodScoreXML{Number: p.Number, Type: periodType, HomeScore: h, AwayScore: a}
		hh, aa := h, a
		switch family {
		case FamilyRounds:
			row.HomeWonRounds, row.AwayWonRounds = &hh, &aa
		case FamilyKills:
			row.HomeKills, row.AwayKills = &hh, &aa
		case FamilyGoals:
			row.HomeGoals, row.AwayGoals = &hh, &aa
		}
		if i == live {
			six := 6 // UOF "in progress" — deriveCurrentMap honours it directly
			row.MatchStatusCode = &six
			sb := &scoreboardXML{}
			switch family {
			case FamilyRounds:
				sb.HomeWonRounds, sb.AwayWonRounds = &hh, &aa
			case FamilyKills:
				sb.HomeKills, sb.AwayKills = &hh, &aa
			case FamilyGoals:
				sb.HomeGoals, sb.AwayGoals = &hh, &aa
			}
			if family != FamilyGeneric {
				ses.Scoreboard = sb
			}
		}
		ps.Periods = append(ps.Periods, row)
	}
	if len(ps.Periods) > 0 {
		ses.PeriodScores = ps
	}
	return ses
}

// ─── bet_settlement ────────────────────────────────────────────────────────

// SettleCandidate is one CLOSED market whose every offered outcome has a
// terminal status, ready to be voiced as a bet_settlement market element.
type SettleCandidate struct {
	Key      bifrost.MarketKey
	Outcomes []SettledOutcome
}

type SettledOutcome struct {
	ID         string
	Result     string // "1" won, "0" lost
	VoidFactor string // "" none, "0.5" half, "1" full refund
}

// SettleCandidates lists the markets of a snapshot that are fully settled
// on Bifrost's side. INACTIVE outcomes are dropped (never offered, never
// resolved); a CLOSED market that still shows an OPEN or SUSPENDED outcome
// is skipped as an inconsistent intermediate frame.
func SettleCandidates(m *bifrost.Match) []SettleCandidate {
	var out []SettleCandidate
	for _, km := range collectMarkets(m) {
		if km.market.State != bifrost.MarketClosed {
			continue
		}
		c := SettleCandidate{Key: km.key}
		consistent := true
		for _, ko := range km.outcomes {
			if ko.outcome.Status == bifrost.OutcomeInactive {
				continue
			}
			res, vf, ok := settleFor(ko.outcome.Status)
			if !ok {
				consistent = false
				break
			}
			c.Outcomes = append(c.Outcomes, SettledOutcome{ID: ko.id, Result: res, VoidFactor: vf})
		}
		if !consistent || len(c.Outcomes) == 0 {
			continue
		}
		out = append(out, c)
	}
	return out
}

// settleFor maps a terminal outcome status onto Oddin's (result,
// void_factor) pair. The settlement service's mapOutcomeResult turns them
// back into won / lost / half_won / half_lost / void.
func settleFor(status string) (result, voidFactor string, ok bool) {
	switch status {
	case bifrost.OutcomeWon:
		return "1", "", true
	case bifrost.OutcomeLost:
		return "0", "", true
	case bifrost.OutcomeHalfWon:
		return "1", "0.5", true
	case bifrost.OutcomeHalfLost:
		return "0", "0.5", true
	case bifrost.OutcomeVoided:
		return "0", "1", true
	}
	return "", "", false
}

// BetSettlement renders the given candidates as one bet_settlement for
// the match. certainty is 2 (post-game) once the match is CLOSED and 1
// (live) while it is still running.
func BetSettlement(m *bifrost.Match, candidates []SettleCandidate, nowMs int64) ([]byte, error) {
	urn := m.URN()
	if urn == "" {
		return nil, fmt.Errorf("match %q: no urn", m.ID)
	}
	if len(candidates) == 0 {
		return nil, nil
	}
	certainty := 1
	if m.State == bifrost.MatchClosed {
		certainty = 2
	}
	doc := betSettlementXML{
		EventID:   urn,
		Product:   Product(m.State),
		Timestamp: nowMs,
		Certainty: certainty,
	}
	for _, c := range candidates {
		mk := settleMarketXML{ID: c.Key.ProviderMarketID, Specifiers: c.Key.Specifiers}
		for _, o := range c.Outcomes {
			mk.Outcomes = append(mk.Outcomes, settleOutcomeXML{ID: o.ID, Result: o.Result, VoidFactor: o.VoidFactor})
		}
		doc.Outcomes.Markets = append(doc.Outcomes.Markets, mk)
	}
	return marshal(doc)
}

func marshal(v any) ([]byte, error) {
	b, err := xml.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("marshal: %w", err)
	}
	return append([]byte(xml.Header), b...), nil
}

func atoi(s string) (int, bool) {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0, false
	}
	return n, true
}
