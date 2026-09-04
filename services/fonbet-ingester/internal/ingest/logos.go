package ingest

import (
	"context"
	"strconv"

	"github.com/oddzilla/fonbet-ingester/internal/fonbet"
	"github.com/oddzilla/fonbet-ingester/internal/store"
)

// ApplyLogos stamps Fonbet CDN logos onto the sports / competitors /
// tournaments this provider created and that still have no logo. Safe to
// call on every refresh: rows with a logo (Fonbet's or an operator's) are
// left alone, so it only ever fills gaps for entities created since the
// last pass.
func (in *Ingester) ApplyLogos(ctx context.Context, logos *fonbet.Logos) error {
	if logos == nil {
		return nil
	}
	var sURN, sURL, cURN, cURL, tURN, tURL []string
	for id, url := range logos.Sports {
		sURN = append(sURN, store.URNSport+strconv.Itoa(id))
		sURL = append(sURL, url)
	}
	for id, url := range logos.Teams {
		cURN = append(cURN, store.URNCompetitor+strconv.FormatInt(id, 10))
		cURL = append(cURL, url)
	}
	for id, url := range logos.Competitions {
		tURN = append(tURN, store.URNTournament+strconv.Itoa(id))
		tURL = append(tURL, url)
	}
	n, err := store.ApplyLogos(ctx, in.st.Pool(), sURN, sURL, cURN, cURL, tURN, tURL)
	if err != nil {
		return err
	}
	in.log.Info().Int("sports", len(sURN)).Int("teams", len(cURN)).Int("tournaments", len(tURN)).
		Int64("updated_rows", n).Msg("logos applied")
	return nil
}
