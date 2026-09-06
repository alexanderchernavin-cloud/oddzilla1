package store

import (
	"context"
	"fmt"

	"github.com/oddzilla/fonbet-ingester/internal/mapper"
)

// LoadMarketDenylist reads fonbet_market_denylist (migration
// 20260906T103343_settlement_operator_tools): the catalogue tables and
// sub-event label prefixes the mapper must not turn into markets because
// no grader can settle them from the data we have.
// Admin-managed at /admin/unsettled/denylist; the ingester re-reads it
// every minute so a new rule takes effect without a restart.
func LoadMarketDenylist(ctx context.Context, db pgxRunner) (*mapper.Denylist, error) {
	rows, err := db.Query(ctx, `
SELECT kind, provider_market_id, label_prefix
  FROM fonbet_market_denylist`)
	if err != nil {
		return nil, fmt.Errorf("load market denylist: %w", err)
	}
	defer rows.Close()
	d := &mapper.Denylist{Tables: map[int]struct{}{}}
	for rows.Next() {
		var (
			kind   string
			pmid   *int32
			prefix *string
		)
		if err := rows.Scan(&kind, &pmid, &prefix); err != nil {
			return nil, fmt.Errorf("scan denylist row: %w", err)
		}
		switch {
		case kind == "table" && pmid != nil:
			d.Tables[int(*pmid)] = struct{}{}
		case kind == "label_prefix" && prefix != nil && *prefix != "":
			d.LabelPrefixes = append(d.LabelPrefixes, *prefix)
		}
	}
	return d, rows.Err()
}
