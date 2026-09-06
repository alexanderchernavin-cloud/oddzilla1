package translate

import (
	"encoding/xml"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/oddzilla/bifrost-feed/internal/bifrost"
)

// ─── bet_cancel for maps that were never played ────────────────────────────
//
// Bifrost has no cancel state. When a best-of series ends early (a BO3 at
// 2-0, a BO5 at 3-0) the markets of the maps that were never played simply
// leave its view: the CLOSED snapshot lists only the maps that happened,
// and SettleCandidates therefore never mentions the rest. On Oddin's own
// AMQP feed those markets arrive as a bet_cancel (every selection void,
// stake refunded), which is also the only defensible result for a market
// on a map nobody played. Measured on production 2026-09-06: 2 231 of the
// 5 737 open Oddin markets on matches that had started on 09-05 and closed
// were exactly this shape (78 matches; Vitality vs G2, BO5 3-0, carried 228
// open markets on maps 4 and 5).
//
// The evidence that a map was not played is the snapshot itself: for a
// CLOSED match, the highest map number any listed market carries is the
// last map played, and so is the number of scored periods. A market WE hold
// with a higher map number is a map that did not happen. Only those are
// cancelled — a dropped ladder line on a played map is a different problem
// (services/settlement infers it from settled siblings) and is never
// voided here, because a played market has a real result somewhere.

type betCancelXML struct {
	XMLName   xml.Name          `xml:"bet_cancel"`
	EventID   string            `xml:"event_id,attr"`
	Product   int               `xml:"product,attr"`
	Timestamp int64             `xml:"timestamp,attr"`
	Markets   []cancelMarketXML `xml:"market"`
}

type cancelMarketXML struct {
	ID         int    `xml:"id,attr"`
	Specifiers string `xml:"specifiers,attr,omitempty"`
}

// MapsPlayed reports how many maps of the match the snapshot proves were
// played: the larger of the highest `map` specifier on any listed market
// and the number of periods carrying a numeric score. 0 means the snapshot
// carries neither and nothing can be concluded (a CLOSED live-view frame
// arrives with an empty marketGroups, for instance).
func MapsPlayed(m *bifrost.Match) int {
	played := 0
	for _, km := range collectMarkets(m) {
		if n, ok := mapNumber(km.key.Specifiers); ok && n > played {
			played = n
		}
	}
	if s := m.SimpleScore; s != nil {
		scored := 0
		for _, p := range s.Periods {
			if _, okH := atoi(p.Home); okH {
				if _, okA := atoi(p.Away); okA {
					scored++
				}
			}
		}
		if scored > played {
			played = scored
		}
	}
	return played
}

// UnplayedMapCancels lists, for a CLOSED match, the open market keys whose
// `map` specifier is beyond the last map played. Anything else — match-level
// markets, played-map markets, a match that is not CLOSED, a snapshot that
// proves nothing — yields no cancels. Sorted so two calls over the same
// input render byte-identical.
func UnplayedMapCancels(m *bifrost.Match, open map[bifrost.MarketKey]struct{}) []bifrost.MarketKey {
	if m == nil || m.State != bifrost.MatchClosed || len(open) == 0 {
		return nil
	}
	played := MapsPlayed(m)
	if played == 0 {
		return nil
	}
	var out []bifrost.MarketKey
	for key := range open {
		if n, ok := mapNumber(key.Specifiers); ok && n > played {
			out = append(out, key)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ProviderMarketID != out[j].ProviderMarketID {
			return out[i].ProviderMarketID < out[j].ProviderMarketID
		}
		return out[i].Specifiers < out[j].Specifiers
	})
	return out
}

// BetCancel renders the keys as one bet_cancel with no time window, which
// the settlement service applies as a full void of every selection.
func BetCancel(m *bifrost.Match, keys []bifrost.MarketKey, nowMs int64) ([]byte, error) {
	urn := m.URN()
	if urn == "" {
		return nil, fmt.Errorf("match %q: no urn", m.ID)
	}
	if len(keys) == 0 {
		return nil, nil
	}
	doc := betCancelXML{EventID: urn, Product: Product(m.State), Timestamp: nowMs}
	for _, k := range keys {
		doc.Markets = append(doc.Markets, cancelMarketXML{ID: k.ProviderMarketID, Specifiers: k.Specifiers})
	}
	return marshal(doc)
}

// mapNumber extracts the `map` specifier from a canonical `k=v|k=v` string.
func mapNumber(specifiers string) (int, bool) {
	for _, kv := range strings.Split(specifiers, "|") {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || k != "map" {
			continue
		}
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return 0, false
		}
		return n, true
	}
	return 0, false
}
