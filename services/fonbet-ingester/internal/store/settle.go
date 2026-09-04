package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// PendingMatch is a closed Fonbet match that still has non-terminal
// markets — the settlement worker's work list.
type PendingMatch struct {
	MatchID   int64
	URN       string
	HomeTeam  string
	AwayTeam  string
	StartTime int64 // unix seconds
	SegmentID int   // Fonbet competition id (from the tournament URN)
	Markets   []PendingMarket
}

type PendingMarket struct {
	ID         int64
	PMID       int
	Specs      map[string]string
	OutcomeIDs []string
}

// LoadPendingSettlement returns Fonbet matches (scheduled within the last
// `days`) whose markets are not all terminal, with those markets: closed
// matches, plus not_started ones more than three hours past kick-off —
// events Fonbet dropped from the line without ever going live (postponed,
// abandoned). The results feed then decides: finished → graded, status 4
// → voided, absent → stays pending.
func LoadPendingSettlement(ctx context.Context, db pgxRunner, days int) ([]PendingMatch, error) {
	rows, err := db.Query(ctx, `
SELECT ma.id, ma.provider_urn, ma.home_team, ma.away_team,
       COALESCE(EXTRACT(EPOCH FROM ma.scheduled_at)::bigint, 0), t.provider_urn
  FROM matches ma
  JOIN tournaments t ON t.id = ma.tournament_id
 WHERE ma.provider_urn LIKE 'fb:match:%'
   AND (ma.status = 'closed'
        OR (ma.status = 'not_started' AND ma.scheduled_at < NOW() - INTERVAL '3 hours'))
   AND ma.scheduled_at > NOW() - ($1 || ' days')::interval
   AND EXISTS (SELECT 1 FROM markets mk WHERE mk.match_id = ma.id AND mk.status NOT IN (-3, -4))
 ORDER BY ma.scheduled_at`, strconv.Itoa(days))
	if err != nil {
		return nil, fmt.Errorf("load pending settlement matches: %w", err)
	}
	byID := map[int64]*PendingMatch{}
	var ids []int64
	for rows.Next() {
		var m PendingMatch
		var tURN string
		if err := rows.Scan(&m.MatchID, &m.URN, &m.HomeTeam, &m.AwayTeam, &m.StartTime, &tURN); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan pending match: %w", err)
		}
		m.SegmentID, _ = strconv.Atoi(strings.TrimPrefix(tURN, URNTournament))
		byID[m.MatchID] = &m
		ids = append(ids, m.MatchID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, nil
	}
	mrows, err := db.Query(ctx, `
SELECT mk.id, mk.match_id, mk.provider_market_id, mk.specifiers_json::text,
       COALESCE(array_agg(mo.outcome_id ORDER BY mo.outcome_id) FILTER (WHERE mo.outcome_id IS NOT NULL), '{}')
  FROM markets mk
  LEFT JOIN market_outcomes mo ON mo.market_id = mk.id
 WHERE mk.match_id = ANY($1::bigint[])
   AND mk.status NOT IN (-3, -4)
 GROUP BY mk.id, mk.match_id, mk.provider_market_id, mk.specifiers_json`, ids)
	if err != nil {
		return nil, fmt.Errorf("load pending markets: %w", err)
	}
	defer mrows.Close()
	for mrows.Next() {
		var pm PendingMarket
		var matchID int64
		var pmid int32
		var specJSON string
		if err := mrows.Scan(&pm.ID, &matchID, &pmid, &specJSON, &pm.OutcomeIDs); err != nil {
			return nil, fmt.Errorf("scan pending market: %w", err)
		}
		pm.PMID = int(pmid)
		pm.Specs = map[string]string{}
		if err := json.Unmarshal([]byte(specJSON), &pm.Specs); err != nil {
			// A market whose specifiers cannot be read must not be graded as
			// the main-time market by accident: skip it (stays open for
			// manual settlement) and say so.
			return nil, fmt.Errorf("market %d: decode specifiers_json %q: %w", pm.ID, specJSON, err)
		}
		if m := byID[matchID]; m != nil {
			m.Markets = append(m.Markets, pm)
		}
	}
	if err := mrows.Err(); err != nil {
		return nil, err
	}
	out := make([]PendingMatch, 0, len(ids))
	for _, id := range ids {
		if m := byID[id]; len(m.Markets) > 0 {
			out = append(out, *m)
		}
	}
	return out, nil
}

// LoadVariantLabels rebuilds the sub-event label per `variant` value from
// the description rows this service wrote ("1-й тайм: Исходы" → "1-й тайм").
func LoadVariantLabels(ctx context.Context, db pgxRunner, lang string) (map[string]string, error) {
	rows, err := db.Query(ctx, `
SELECT DISTINCT variant, name_template
  FROM market_descriptions
 WHERE variant LIKE 'fb:%' AND language = $1`, lang)
	if err != nil {
		return nil, fmt.Errorf("load variant labels: %w", err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var variant, tpl string
		if err := rows.Scan(&variant, &tpl); err != nil {
			return nil, err
		}
		if i := strings.Index(tpl, ": "); i > 0 {
			if _, seen := out[variant]; !seen {
				out[variant] = tpl[:i]
			}
		}
	}
	return out, rows.Err()
}
