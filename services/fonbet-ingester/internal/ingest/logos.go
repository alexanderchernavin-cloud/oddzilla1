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
//
// Tournaments have TWO upstream sources and this is where they merge:
// logos.Competitions (line/logos) and tournamentIcons (the events/list
// tournamentInfos block — see fonbet.Client.TournamentIcons). They index
// different asset trees and neither is a superset, so the second only
// fills segments the first has no mark for.
func (in *Ingester) ApplyLogos(ctx context.Context, logos *fonbet.Logos, tournamentIcons map[int]string) error {
	if logos == nil && len(tournamentIcons) == 0 {
		return nil
	}
	var sURN, sURL, cURN, cURL, tURN, tURL []string
	tours := make(map[int]string)
	if logos != nil {
		for id, url := range logos.Sports {
			sURN = append(sURN, store.URNSport+strconv.Itoa(id))
			sURL = append(sURL, url)
		}
		for id, url := range logos.Teams {
			cURN = append(cURN, store.URNCompetitor+strconv.FormatInt(id, 10))
			cURL = append(cURL, url)
		}
		for id, url := range logos.Competitions {
			tours[id] = url
		}
	}
	extra := 0
	for id, url := range tournamentIcons {
		if _, ok := tours[id]; ok {
			continue
		}
		tours[id] = url
		extra++
	}
	for id, url := range tours {
		tURN = append(tURN, store.URNTournament+strconv.Itoa(id))
		tURL = append(tURL, url)
	}
	n, err := store.ApplyLogos(ctx, in.st.Pool(), sURN, sURL, cURN, cURL, tURN, tURL)
	if err != nil {
		return err
	}
	in.log.Info().Int("sports", len(sURN)).Int("teams", len(cURN)).Int("tournaments", len(tURN)).
		Int("tournaments_from_infos", extra).Int64("updated_rows", n).Msg("logos applied")
	return nil
}
