package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// MarketUpsert carries everything needed to upsert one row into `markets`.
type MarketUpsert struct {
	ProviderMarketID int
	SpecifiersJSON   map[string]string
	SpecifiersHash   []byte
	Status           int16
	SourceTs         int64 // ms
}

// MarketUpsertResult maps the natural key back to the db id and reports
// the status transition so the caller can publish marketStatus frames.
type MarketUpsertResult struct {
	ProviderMarketID int
	SpecifiersHash   []byte
	ID               int64
	NewStatus        int16
	PrevStatus       int16
}

// UpsertMarketsBulk is one UNNEST upsert for every market of one match.
// Terminal statuses (-3 settled / -4 cancelled) are sticky — the
// settlement service owns them (CLAUDE.md invariant 9).
func UpsertMarketsBulk(ctx context.Context, db pgxRunner, matchID int64, markets []MarketUpsert) ([]MarketUpsertResult, error) {
	if len(markets) == 0 {
		return nil, nil
	}
	providerIDs := make([]int32, len(markets))
	specJSONs := make([]string, len(markets))
	specHashes := make([][]byte, len(markets))
	statuses := make([]int32, len(markets))
	lastTs := make([]int64, len(markets))
	for i, m := range markets {
		providerIDs[i] = int32(m.ProviderMarketID)
		jb, err := json.Marshal(m.SpecifiersJSON)
		if err != nil {
			return nil, fmt.Errorf("marshal specifiers[%d]: %w", i, err)
		}
		specJSONs[i] = string(jb)
		specHashes[i] = m.SpecifiersHash
		statuses[i] = int32(m.Status)
		lastTs[i] = m.SourceTs
	}
	const q = `
WITH inp AS (
  SELECT t.pmid, t.spec, t.hash, t.status, t.lts
    FROM UNNEST($2::int[], $3::text[], $4::bytea[], $5::int[], $6::bigint[])
         AS t(pmid, spec, hash, status, lts)
),
old AS (
  SELECT m.provider_market_id, m.specifiers_hash, m.status AS prev_status
    FROM markets m
    JOIN inp ON inp.pmid = m.provider_market_id
            AND inp.hash = m.specifiers_hash
   WHERE m.match_id = $1
),
ins AS (
  INSERT INTO markets
    (match_id, provider_market_id, specifiers_json, specifiers_hash, status, last_oddin_ts, updated_at)
  SELECT $1, inp.pmid, inp.spec::jsonb, inp.hash, inp.status, inp.lts, NOW()
    FROM inp
  ON CONFLICT (match_id, provider_market_id, specifiers_hash) DO UPDATE
     SET status        = CASE WHEN markets.status IN (-3, -4) THEN markets.status        ELSE EXCLUDED.status END,
         last_oddin_ts = CASE WHEN markets.status IN (-3, -4) THEN markets.last_oddin_ts ELSE GREATEST(markets.last_oddin_ts, EXCLUDED.last_oddin_ts) END,
         updated_at    = CASE WHEN markets.status IN (-3, -4) THEN markets.updated_at    ELSE NOW() END
  RETURNING id, provider_market_id, specifiers_hash, status
)
SELECT ins.id, ins.provider_market_id, ins.specifiers_hash, ins.status,
       COALESCE(old.prev_status, ins.status) AS prev_status
  FROM ins
  LEFT JOIN old
    ON old.provider_market_id = ins.provider_market_id
   AND old.specifiers_hash = ins.specifiers_hash`
	rows, err := db.Query(ctx, q, matchID, providerIDs, specJSONs, specHashes, statuses, lastTs)
	if err != nil {
		return nil, fmt.Errorf("upsert markets bulk: %w", err)
	}
	defer rows.Close()
	out := make([]MarketUpsertResult, 0, len(markets))
	for rows.Next() {
		var r MarketUpsertResult
		var pmid, newStatus, prevStatus int32
		if err := rows.Scan(&r.ID, &pmid, &r.SpecifiersHash, &newStatus, &prevStatus); err != nil {
			return nil, fmt.Errorf("scan upsert markets bulk: %w", err)
		}
		r.ProviderMarketID = int(pmid)
		r.NewStatus = int16(newStatus)
		r.PrevStatus = int16(prevStatus)
		out = append(out, r)
	}
	return out, rows.Err()
}

// OutcomeUpsert is one market_outcomes row.
type OutcomeUpsert struct {
	MarketID  int64
	OutcomeID string
	Name      string
	RawOdds   *string
	Active    bool
	SourceTs  int64
}

// UpsertOutcomesBulk applies every outcome in one UNNEST INSERT. Only
// raw_odds / active / name / last_oddin_ts are touched — published_odds
// belongs to odds-publisher and result to settlement. Unchanged rows are a
// 0-row write thanks to the DO UPDATE WHERE guard.
func UpsertOutcomesBulk(ctx context.Context, db pgxRunner, rows []OutcomeUpsert) error {
	if len(rows) == 0 {
		return nil
	}
	marketIDs := make([]int64, len(rows))
	outcomeIDs := make([]string, len(rows))
	names := make([]string, len(rows))
	rawOdds := make([]*string, len(rows))
	actives := make([]bool, len(rows))
	lastTs := make([]int64, len(rows))
	for i, r := range rows {
		marketIDs[i] = r.MarketID
		outcomeIDs[i] = r.OutcomeID
		names[i] = r.Name
		rawOdds[i] = r.RawOdds
		actives[i] = r.Active
		lastTs[i] = r.SourceTs
	}
	const q = `
INSERT INTO market_outcomes
  (market_id, outcome_id, name, raw_odds, active, last_oddin_ts, updated_at)
SELECT t.mid, t.oid, t.nm, t.odds::numeric, t.act, t.lts, NOW()
  FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::text[], $5::bool[], $6::bigint[])
       AS t(mid, oid, nm, odds, act, lts)
ON CONFLICT (market_id, outcome_id) DO UPDATE
   SET raw_odds      = COALESCE(EXCLUDED.raw_odds, market_outcomes.raw_odds),
       active        = EXCLUDED.active,
       name          = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE market_outcomes.name END,
       last_oddin_ts = GREATEST(market_outcomes.last_oddin_ts, EXCLUDED.last_oddin_ts),
       updated_at    = NOW()
 WHERE market_outcomes.active IS DISTINCT FROM EXCLUDED.active
    OR (EXCLUDED.raw_odds IS NOT NULL
        AND market_outcomes.raw_odds IS DISTINCT FROM EXCLUDED.raw_odds::numeric)
    OR (EXCLUDED.name <> '' AND market_outcomes.name IS DISTINCT FROM EXCLUDED.name)`
	if _, err := db.Exec(ctx, q, marketIDs, outcomeIDs, names, rawOdds, actives, lastTs); err != nil {
		return fmt.Errorf("upsert outcomes bulk: %w", err)
	}
	return nil
}

// DeactivateOutcomes nulls odds and flips active=false on the given
// (market_id, outcome_id) pairs — the outcomes Fonbet dropped from a
// market that is still on offer.
func DeactivateOutcomes(ctx context.Context, db pgxRunner, marketIDs []int64, outcomeIDs []string, ts int64) error {
	if len(marketIDs) == 0 {
		return nil
	}
	if len(marketIDs) != len(outcomeIDs) {
		return fmt.Errorf("deactivate outcomes: array length mismatch")
	}
	const q = `
UPDATE market_outcomes mo
   SET active         = FALSE,
       published_odds = NULL,
       raw_odds       = NULL,
       probability    = NULL,
       last_oddin_ts  = GREATEST(mo.last_oddin_ts, $3),
       updated_at     = NOW()
  FROM UNNEST($1::bigint[], $2::text[]) AS t(mid, oid)
 WHERE mo.market_id = t.mid
   AND mo.outcome_id = t.oid
   AND mo.active = TRUE`
	if _, err := db.Exec(ctx, q, marketIDs, outcomeIDs, ts); err != nil {
		return fmt.Errorf("deactivate outcomes: %w", err)
	}
	return nil
}

// SetMarketsStatus flips the given markets to `status` unless they are
// terminal. Used for markets that vanished from the snapshot (→ 0) and
// for the staleness / shutdown suspend (→ -1). Returns (match_id, id)
// pairs that actually changed so the caller can publish marketStatus.
func SetMarketsStatus(ctx context.Context, db pgxRunner, marketIDs []int64, status int16, ts int64) ([]MatchMarketRef, error) {
	if len(marketIDs) == 0 {
		return nil, nil
	}
	rows, err := db.Query(ctx, `
UPDATE markets
   SET status = $2,
       last_oddin_ts = GREATEST(last_oddin_ts, $3),
       updated_at = NOW()
 WHERE id = ANY($1::bigint[])
   AND status NOT IN (-3, -4)
   AND status <> $2
RETURNING match_id, id`, marketIDs, status, ts)
	if err != nil {
		return nil, fmt.Errorf("set markets status: %w", err)
	}
	defer rows.Close()
	var out []MatchMarketRef
	for rows.Next() {
		var r MatchMarketRef
		if err := rows.Scan(&r.MatchID, &r.MarketID); err != nil {
			return nil, fmt.Errorf("scan market ref: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

type MatchMarketRef struct {
	MatchID  int64
	MarketID int64
}

// SuspendProviderCatalog suspends every active Fonbet market on a
// not_started/live match and nulls its outcome odds. Mirrors
// feed-ingester's FlushAndSuspendActiveCatalog but scoped to `fb:` URNs so
// an Oddin market is never touched. Race-safe (UPDATE only).
func SuspendProviderCatalog(ctx context.Context, db pgxRunner) ([]MatchMarketRef, int64, error) {
	rows, err := db.Query(ctx, `
UPDATE markets
   SET status = -1, updated_at = NOW()
  FROM matches ma
 WHERE ma.id = markets.match_id
   AND ma.provider_urn LIKE 'fb:match:%'
   AND markets.status = 1
   AND ma.status IN ('not_started', 'live')
RETURNING markets.match_id, markets.id`)
	if err != nil {
		return nil, 0, fmt.Errorf("suspend provider catalog: %w", err)
	}
	refs := make([]MatchMarketRef, 0, 1024)
	for rows.Next() {
		var r MatchMarketRef
		if err := rows.Scan(&r.MatchID, &r.MarketID); err != nil {
			rows.Close()
			return nil, 0, fmt.Errorf("scan suspended ref: %w", err)
		}
		refs = append(refs, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	tag, err := db.Exec(ctx, `
UPDATE market_outcomes
   SET published_odds = NULL, raw_odds = NULL, probability = NULL, active = FALSE, updated_at = NOW()
  FROM markets m
  JOIN matches ma ON ma.id = m.match_id
 WHERE market_outcomes.market_id = m.id
   AND ma.provider_urn LIKE 'fb:match:%'
   AND ma.status IN ('not_started', 'live')
   AND market_outcomes.active = TRUE`)
	if err != nil {
		return nil, 0, fmt.Errorf("suspend provider outcomes: %w", err)
	}
	return refs, tag.RowsAffected(), nil
}

// OddsHistoryRow is one append-only odds_history row.
type OddsHistoryRow struct {
	MarketID  int64
	OutcomeID string
	RawOdds   *string
	Ts        time.Time
}

// AppendOddsHistoryBulk inserts every row in one UNNEST INSERT.
func AppendOddsHistoryBulk(ctx context.Context, db pgxRunner, rows []OddsHistoryRow) error {
	if len(rows) == 0 {
		return nil
	}
	marketIDs := make([]int64, len(rows))
	outcomeIDs := make([]string, len(rows))
	rawOdds := make([]*string, len(rows))
	ts := make([]time.Time, len(rows))
	for i, r := range rows {
		marketIDs[i] = r.MarketID
		outcomeIDs[i] = r.OutcomeID
		rawOdds[i] = r.RawOdds
		ts[i] = r.Ts
	}
	const q = `
INSERT INTO odds_history (market_id, outcome_id, raw_odds, ts)
SELECT t.mid, t.oid, t.raw::numeric, t.ts
  FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::timestamptz[]) AS t(mid, oid, raw, ts)`
	if _, err := db.Exec(ctx, q, marketIDs, outcomeIDs, rawOdds, ts); err != nil {
		return fmt.Errorf("append odds_history bulk: %w", err)
	}
	return nil
}
