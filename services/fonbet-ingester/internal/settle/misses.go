package settle

import "github.com/oddzilla/fonbet-ingester/internal/store"

// missCandidateCap bounds what one miss row carries; a competition rarely
// lists more than a dozen fixtures on a line day.
const missCandidateCap = 20

// missFor builds the fonbet_settlement_misses row for a pending match the
// results feed did not carry under our name: the fixture as we hold it,
// how many of its markets are still open, and every match row the results
// document listed for the same competition on those days — the spelling
// and ordering the two feeds disagree on is usually visible right there.
func missFor(m store.PendingMatch, ri *resultIndex) store.SettlementMiss {
	miss := store.SettlementMiss{
		MatchID:     m.MatchID,
		URN:         m.URN,
		HomeTeam:    m.HomeTeam,
		AwayTeam:    m.AwayTeam,
		StartTime:   m.StartTime,
		SegmentID:   m.SegmentID,
		OpenMarkets: len(m.Markets),
		Candidates:  []store.MissCandidate{},
	}
	for _, rm := range ri.byCompetition[m.SegmentID] {
		if len(miss.Candidates) >= missCandidateCap {
			break
		}
		miss.Candidates = append(miss.Candidates, store.MissCandidate{
			Name: rm.rawName, StartTime: rm.startTime, Score: rm.score, Status: rm.status,
		})
	}
	return miss
}
