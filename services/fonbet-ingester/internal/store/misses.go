package store

import (
	"context"
	"encoding/json"
	"fmt"
)

// SettlementMiss is one pending match the grader could not find in the
// results feed, with what the document DID list for its competition.
type SettlementMiss struct {
	MatchID     int64
	URN         string
	HomeTeam    string
	AwayTeam    string
	StartTime   int64 // unix seconds; 0 when unknown
	SegmentID   int
	OpenMarkets int
	Candidates  []MissCandidate
}

// MissCandidate is one results-feed row for the same competition.
type MissCandidate struct {
	Name      string `json:"name"`
	StartTime int64  `json:"startTime"`
	Score     string `json:"score"`
	Status    int    `json:"status"`
}

// RecordSettlementMisses upserts one fonbet_settlement_misses row per match
// the pass could not find (bumping attempts / last_seen_at on a repeat) and
// deletes the rows of the matches the same pass DID find, so the table is
// always "what is unmatched right now". Both halves are one statement each;
// the grader runs every two minutes over thousands of matches and must not
// pay a round trip per match.
func RecordSettlementMisses(ctx context.Context, db pgxRunner, misses []SettlementMiss, matchedIDs []int64) error {
	if len(matchedIDs) > 0 {
		if _, err := db.Exec(ctx, `DELETE FROM fonbet_settlement_misses WHERE match_id = ANY($1::bigint[])`, matchedIDs); err != nil {
			return fmt.Errorf("clear settlement misses: %w", err)
		}
	}
	if len(misses) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(misses))
	urns := make([]string, 0, len(misses))
	homes := make([]string, 0, len(misses))
	aways := make([]string, 0, len(misses))
	starts := make([]*int64, 0, len(misses))
	segments := make([]int32, 0, len(misses))
	open := make([]int32, 0, len(misses))
	cands := make([]string, 0, len(misses))
	for _, m := range misses {
		ids = append(ids, m.MatchID)
		urns = append(urns, m.URN)
		homes = append(homes, m.HomeTeam)
		aways = append(aways, m.AwayTeam)
		if m.StartTime > 0 {
			st := m.StartTime
			starts = append(starts, &st)
		} else {
			starts = append(starts, nil)
		}
		segments = append(segments, int32(m.SegmentID))
		open = append(open, int32(m.OpenMarkets))
		c := m.Candidates
		if c == nil {
			c = []MissCandidate{}
		}
		raw, err := json.Marshal(c)
		if err != nil {
			raw = []byte("[]")
		}
		cands = append(cands, string(raw))
	}
	_, err := db.Exec(ctx, `
INSERT INTO fonbet_settlement_misses
       (match_id, provider_urn, home_team, away_team, scheduled_at, segment_id, candidates, open_markets)
SELECT id, urn, home, away, to_timestamp(start), segment, cand::jsonb, open
  FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::text[], $5::bigint[], $6::int[], $7::text[], $8::int[])
       AS t(id, urn, home, away, start, segment, cand, open)
ON CONFLICT (match_id) DO UPDATE
   SET candidates   = EXCLUDED.candidates,
       open_markets = EXCLUDED.open_markets,
       last_seen_at = NOW(),
       attempts     = fonbet_settlement_misses.attempts + 1`,
		ids, urns, homes, aways, starts, segments, cands, open)
	if err != nil {
		return fmt.Errorf("record settlement misses: %w", err)
	}
	return nil
}
