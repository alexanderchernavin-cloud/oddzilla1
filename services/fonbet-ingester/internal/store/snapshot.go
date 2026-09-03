package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/oddzilla/fonbet-ingester/internal/specifiers"
)

// StoredMatch / StoredMarket / StoredOutcome are what the ingester loads at
// boot so a restart does not re-write (and re-publish) 200k unchanged
// outcomes: the in-memory "previous snapshot" starts from the database
// instead of empty.
type StoredMatch struct {
	ID          int64
	ProviderURN string
	Status      string
	HomeTeam    string
	AwayTeam    string
	StartTime   int64 // unix seconds, 0 when scheduled_at is NULL
	Markets     []StoredMarket
}

type StoredMarket struct {
	ID               int64
	ProviderMarketID int
	Canonical        string // rebuilt from specifiers_json
	Status           int16
	Outcomes         []StoredOutcome
}

type StoredOutcome struct {
	OutcomeID string
	RawOdds   string // "" when NULL
	Active    bool
}

// LoadProviderState reads every non-terminal Fonbet match with its
// markets and outcomes.
func LoadProviderState(ctx context.Context, db pgxRunner) ([]StoredMatch, error) {
	matchRows, err := db.Query(ctx, `
SELECT id, provider_urn, status::text, home_team, away_team,
       COALESCE(EXTRACT(EPOCH FROM scheduled_at)::bigint, 0)
  FROM matches
 WHERE provider_urn LIKE 'fb:match:%'
   AND status IN ('not_started', 'live')`)
	if err != nil {
		return nil, fmt.Errorf("load provider matches: %w", err)
	}
	byID := map[int64]*StoredMatch{}
	var order []int64
	for matchRows.Next() {
		var m StoredMatch
		if err := matchRows.Scan(&m.ID, &m.ProviderURN, &m.Status, &m.HomeTeam, &m.AwayTeam, &m.StartTime); err != nil {
			matchRows.Close()
			return nil, fmt.Errorf("scan provider match: %w", err)
		}
		byID[m.ID] = &m
		order = append(order, m.ID)
	}
	matchRows.Close()
	if err := matchRows.Err(); err != nil {
		return nil, err
	}
	if len(byID) == 0 {
		return nil, nil
	}

	rows, err := db.Query(ctx, `
SELECT m.id, m.match_id, m.provider_market_id, m.specifiers_json::text, m.status,
       mo.outcome_id, COALESCE(mo.raw_odds::text, ''), COALESCE(mo.active, FALSE)
  FROM markets m
  JOIN matches ma ON ma.id = m.match_id
  LEFT JOIN market_outcomes mo ON mo.market_id = m.id
 WHERE ma.provider_urn LIKE 'fb:match:%'
   AND ma.status IN ('not_started', 'live')
   AND m.status NOT IN (-3, -4)
 ORDER BY m.match_id, m.id`)
	if err != nil {
		return nil, fmt.Errorf("load provider markets: %w", err)
	}
	defer rows.Close()
	var cur *StoredMarket
	var curMatch *StoredMatch
	for rows.Next() {
		var (
			marketID, matchID int64
			pmid              int32
			specJSON          string
			status            int32
			outcomeID         *string
			rawOdds           string
			active            bool
		)
		if err := rows.Scan(&marketID, &matchID, &pmid, &specJSON, &status, &outcomeID, &rawOdds, &active); err != nil {
			return nil, fmt.Errorf("scan provider market: %w", err)
		}
		if cur == nil || cur.ID != marketID {
			curMatch = byID[matchID]
			if curMatch == nil {
				cur = nil
				continue
			}
			curMatch.Markets = append(curMatch.Markets, StoredMarket{
				ID: marketID, ProviderMarketID: int(pmid), Canonical: canonicalFromJSON(specJSON), Status: int16(status),
			})
			cur = &curMatch.Markets[len(curMatch.Markets)-1]
		}
		if outcomeID != nil {
			cur.Outcomes = append(cur.Outcomes, StoredOutcome{OutcomeID: *outcomeID, RawOdds: trimOdds(rawOdds), Active: active})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]StoredMatch, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	return out, nil
}

// canonicalFromJSON rebuilds the `k=v|k=v` form from the jsonb column.
// specifiers_json is always a flat string→string object written by this
// service (or by feed-ingester, same shape).
func canonicalFromJSON(js string) string {
	js = strings.TrimSpace(js)
	if js == "" || js == "{}" {
		return ""
	}
	pairs := map[string]string{}
	if err := json.Unmarshal([]byte(js), &pairs); err != nil {
		return ""
	}
	return specifiers.Canonical(pairs)
}

// trimOdds normalises numeric(10,4) text ("1.8700") to the FormatOdds shape
// ("1.87") so the boot-time comparison against the feed is exact.
func trimOdds(s string) string {
	if s == "" || !strings.Contains(s, ".") {
		return s
	}
	s = strings.TrimRight(s, "0")
	s = strings.TrimRight(s, ".")
	return s
}
