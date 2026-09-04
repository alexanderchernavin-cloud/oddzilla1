package store

import (
	"context"
	"fmt"
)

// ApplyLogos fills logo_url on sports / competitors / tournaments that the
// Fonbet feed created and that have no logo yet. Operator uploads
// (/admin) always win: only NULL logo_url rows are touched, and only rows
// this provider owns. Each call is one UNNEST UPDATE per table.
func ApplyLogos(ctx context.Context, db pgxRunner, sportURNs, sportURLs, compURNs, compURLs, tourURNs, tourURLs []string) (int64, error) {
	var total int64
	if len(sportURNs) > 0 {
		tag, err := db.Exec(ctx, `
UPDATE sports s
   SET logo_url = t.url
  FROM UNNEST($1::text[], $2::text[]) AS t(urn, url)
 WHERE s.provider = $3
   AND s.provider_urn = t.urn
   AND s.logo_url IS NULL`, sportURNs, sportURLs, Provider)
		if err != nil {
			return total, fmt.Errorf("apply sport logos: %w", err)
		}
		total += tag.RowsAffected()
	}
	if len(compURNs) > 0 {
		tag, err := db.Exec(ctx, `
UPDATE competitors c
   SET logo_url = t.url
  FROM UNNEST($1::text[], $2::text[]) AS t(urn, url)
 WHERE c.provider = $3
   AND c.provider_urn = t.urn
   AND c.logo_url IS NULL`, compURNs, compURLs, Provider)
		if err != nil {
			return total, fmt.Errorf("apply competitor logos: %w", err)
		}
		total += tag.RowsAffected()
	}
	if len(tourURNs) > 0 {
		tag, err := db.Exec(ctx, `
UPDATE tournaments tr
   SET logo_url = t.url
  FROM UNNEST($1::text[], $2::text[]) AS t(urn, url)
 WHERE tr.provider_urn = t.urn
   AND tr.provider_urn LIKE 'fb:tournament:%'
   AND tr.logo_url IS NULL`, tourURNs, tourURLs)
		if err != nil {
			return total, fmt.Errorf("apply tournament logos: %w", err)
		}
		total += tag.RowsAffected()
	}
	return total, nil
}
