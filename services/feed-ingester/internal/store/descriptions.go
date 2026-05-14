// Market description upserts. See migration 0006 and package oddinxml for
// the wire shape. Descriptions are refreshed periodically from Oddin's
// REST endpoint; the write path is idempotent (ON CONFLICT DO UPDATE) so
// refresh has no ordering or atomicity requirements.

package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/oddzilla/feed-ingester/internal/oddinxml"
)

// UpsertMarketDescriptions writes the full market + outcome description
// catalog in a single transaction for one Oddin language. Variants of
// "" (no variant) are stored as empty strings, which matches the PK
// default. Stale rows are left behind — market ids + variants are
// stable in Oddin's schema, so the only realistic change is a rename
// of `name_template` or a new outcome being added, both of which the
// ON CONFLICT DO UPDATE handles. The (provider_market_id, variant,
// language) tuple lets the same id live once per shipped language;
// migration 0051 added the column.
func UpsertMarketDescriptions(ctx context.Context, pool *pgxpool.Pool, lang string, markets []oddinxml.MarketDescription) error {
	if len(markets) == 0 {
		return nil
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	for _, m := range markets {
		if err := upsertMarketDescription(ctx, tx, lang, m); err != nil {
			return fmt.Errorf("upsert market %d (%q, lang=%s): %w", m.ID, m.Variant, lang, err)
		}
	}
	return tx.Commit(ctx)
}

func upsertMarketDescription(ctx context.Context, tx pgx.Tx, lang string, m oddinxml.MarketDescription) error {
	specs, err := json.Marshal(m.Specifiers)
	if err != nil {
		return fmt.Errorf("marshal specifiers: %w", err)
	}

	const marketSQL = `
		INSERT INTO market_descriptions (provider_market_id, variant, language, name_template, specifiers_json, updated_at)
		VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
		ON CONFLICT (provider_market_id, variant, language) DO UPDATE
		  SET name_template   = EXCLUDED.name_template,
		      specifiers_json = EXCLUDED.specifiers_json,
		      updated_at      = NOW()
	`
	if _, err := tx.Exec(ctx, marketSQL, m.ID, m.Variant, lang, m.Name, specs); err != nil {
		return err
	}

	const outcomeSQL = `
		INSERT INTO outcome_descriptions (provider_market_id, variant, outcome_id, language, name_template, updated_at)
		VALUES ($1, $2, $3, $4, $5, NOW())
		ON CONFLICT (provider_market_id, variant, outcome_id, language) DO UPDATE
		  SET name_template = EXCLUDED.name_template,
		      updated_at    = NOW()
	`
	for _, o := range m.Outcomes {
		if _, err := tx.Exec(ctx, outcomeSQL, m.ID, m.Variant, o.ID, lang, o.Name); err != nil {
			return err
		}
	}
	return nil
}

// CountMarketDescriptions returns the number of market_descriptions rows,
// used by the health/startup log to confirm the cache was populated.
func CountMarketDescriptions(ctx context.Context, pool *pgxpool.Pool) (int, error) {
	var n int
	err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM market_descriptions`).Scan(&n)
	if err != nil {
		return 0, err
	}
	return n, nil
}
