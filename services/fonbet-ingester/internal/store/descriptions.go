package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// MarketDescription is one (provider_market_id, variant, language) template
// plus its outcome templates.
type MarketDescription struct {
	ProviderMarketID int
	Variant          string
	Lang             string
	Name             string
	Outcomes         map[string]string
}

// UpsertDescriptions writes market + outcome templates in one batch.
// Idempotent (ON CONFLICT DO UPDATE), so re-running on every boot is safe.
func UpsertDescriptions(ctx context.Context, db pgxRunner, descs []MarketDescription) error {
	if len(descs) == 0 {
		return nil
	}
	const marketSQL = `
INSERT INTO market_descriptions (provider_market_id, variant, language, name_template, specifiers_json, updated_at)
VALUES ($1, $2, $3, $4, '[]'::jsonb, NOW())
ON CONFLICT (provider_market_id, variant, language) DO UPDATE
  SET name_template = EXCLUDED.name_template,
      updated_at    = NOW()`
	const outcomeSQL = `
INSERT INTO outcome_descriptions (provider_market_id, variant, outcome_id, language, name_template, updated_at)
VALUES ($1, $2, $3, $4, $5, NOW())
ON CONFLICT (provider_market_id, variant, outcome_id, language) DO UPDATE
  SET name_template = EXCLUDED.name_template,
      updated_at    = NOW()`
	batch := &pgx.Batch{}
	n := 0
	for _, d := range descs {
		batch.Queue(marketSQL, d.ProviderMarketID, d.Variant, d.Lang, d.Name)
		n++
		for oid, tpl := range d.Outcomes {
			batch.Queue(outcomeSQL, d.ProviderMarketID, d.Variant, oid, d.Lang, tpl)
			n++
		}
	}
	br := db.SendBatch(ctx, batch)
	defer br.Close()
	for i := 0; i < n; i++ {
		if _, err := br.Exec(); err != nil {
			return fmt.Errorf("upsert description[%d]: %w", i, err)
		}
	}
	return nil
}
