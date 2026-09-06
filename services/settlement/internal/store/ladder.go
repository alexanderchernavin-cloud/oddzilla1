package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ─── Ladder lines stranded open beside settled siblings ───────────────────
//
// A "ladder" is the family of markets that differ only in their line: the
// total-kills market at 24.5 / 25.5 / 26.5, the map handicap at -1.5 / +1.5.
// Oddin's AMQP feed settles every line it ever offered; the Bifrost backup
// feed settles only the lines still in its CLOSED view, so the lines it
// replaced during the match (the total moved from 25.5 to 26.5, say) stay
// open on our side with no result — measured 2026-09-06 at 3 340 open lines
// on the matches that started on 09-05, 97% of which had a settled sibling.
//
// The sibling is enough. A total and a handicap are monotonic in the line:
// if "over 25.5" won, the total was at least 26, so "over 24.5" won too;
// if home -1.5 won, home won by at least two maps, so home -0.5 won too.
// This query hands the settler every open line on a finished Oddin match
// together with the settled lines of its family; settler.inferLine does the
// arithmetic and applyMarketSettle writes the result through the ordinary
// apply-once path. Nothing here is a guess: a line is settled only when a
// sibling's result implies it strictly.

// LadderSibling is one settled line of the same family as an open line.
type LadderSibling struct {
	Line    string // the sibling's own line value, as stored
	Results string // "outcome_id:result:void_factor,..." for its settled outcomes
}

// OpenLadderLine is one non-terminal total / handicap market on a closed
// Oddin match, with every settled sibling of its family.
type OpenLadderLine struct {
	MarketID         int64
	EventURN         string
	ProviderMarketID int
	SpecifiersJSON   string // the market's specifiers_json, verbatim
	LineKey          string // "threshold" or "handicap"
	OutcomeIDs       string // comma-joined outcome ids of the open market
	Siblings         []LadderSibling
}

// OpenLadderLinesWithSettledSiblings lists the open ladder lines on Oddin
// matches that closed more than an hour ago (updated_at is the close stamp
// on a closed match) and started within lookbackDays, each with its settled
// siblings. Exactly one line key must be present — a market carrying both a
// threshold and a handicap is not a ladder we know how to read. Families
// are matched on every OTHER specifier being identical, so a map-2 line
// never borrows a map-1 result.
func OpenLadderLinesWithSettledSiblings(ctx context.Context, pool *pgxpool.Pool, lookbackDays int) ([]OpenLadderLine, error) {
	rows, err := pool.Query(ctx, `
WITH open_lines AS (
  SELECT mk.id, mk.match_id, m.provider_urn, mk.provider_market_id, mk.specifiers_json,
         CASE WHEN mk.specifiers_json ? 'threshold' THEN 'threshold' ELSE 'handicap' END AS line_key
    FROM markets mk
    JOIN matches m ON m.id = mk.match_id
   WHERE m.status = 'closed'
     AND m.provider_urn LIKE 'od:match:%'
     AND m.updated_at < NOW() - INTERVAL '1 hour'
     AND m.scheduled_at > NOW() - ($1 || ' days')::interval
     AND mk.status NOT IN (-3, -4)
     AND (mk.specifiers_json ? 'threshold') <> (mk.specifiers_json ? 'handicap')
)
SELECT o.id, o.provider_urn, o.provider_market_id, o.specifiers_json::text, o.line_key,
       COALESCE((SELECT string_agg(mo.outcome_id, ',' ORDER BY mo.outcome_id)
                   FROM market_outcomes mo WHERE mo.market_id = o.id), ''),
       s.specifiers_json ->> o.line_key,
       COALESCE((SELECT string_agg(mo.outcome_id || ':' || mo.result::text || ':' || COALESCE(mo.void_factor::text, ''), ',' ORDER BY mo.outcome_id)
                   FROM market_outcomes mo WHERE mo.market_id = s.id AND mo.result IS NOT NULL), '')
  FROM open_lines o
  JOIN markets s
    ON s.match_id = o.match_id
   AND s.provider_market_id = o.provider_market_id
   AND s.status = -3
   AND (s.specifiers_json - o.line_key) = (o.specifiers_json - o.line_key)
 ORDER BY o.id, s.id`, fmt.Sprint(lookbackDays))
	if err != nil {
		return nil, fmt.Errorf("open ladder lines: %w", err)
	}
	defer rows.Close()

	var out []OpenLadderLine
	var cur *OpenLadderLine
	for rows.Next() {
		var (
			id       int64
			urn      string
			pmid     int
			specJSON string
			lineKey  string
			outIDs   string
			sibLine  *string
			sibRes   string
		)
		if err := rows.Scan(&id, &urn, &pmid, &specJSON, &lineKey, &outIDs, &sibLine, &sibRes); err != nil {
			return nil, fmt.Errorf("scan ladder line: %w", err)
		}
		if cur == nil || cur.MarketID != id {
			out = append(out, OpenLadderLine{MarketID: id, EventURN: urn, ProviderMarketID: pmid, SpecifiersJSON: specJSON, LineKey: lineKey, OutcomeIDs: outIDs})
			cur = &out[len(out)-1]
		}
		if sibLine != nil && sibRes != "" {
			cur.Siblings = append(cur.Siblings, LadderSibling{Line: *sibLine, Results: sibRes})
		}
	}
	return out, rows.Err()
}
