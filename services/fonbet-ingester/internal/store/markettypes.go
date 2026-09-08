package store

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/oddzilla/fonbet-ingester/internal/mapper"
)

// The provider_market_types registry: our own provider_market_id per
// (provider, market type), from migration 20260908T115542.
//
// Until that migration a Fonbet market's id was `1_000_000 + catalogue
// table`, and Fonbet reuses one table across every sub-event — "Match
// result", "2nd half: Match result" and "Corners: Match result" were all
// 1000120. Every reader keying off the integer alone got the wrong market.
//
// The id is now OURS and opaque. That is the accepted trade-off for
// owning it: nothing can recover the Fonbet table from the number, so the
// registry keeps (table_num, variant, double_chance) on every row and this
// package is the only thing that translates.

// MarketTypeKey is a market type as the provider states it, before we
// allocate an id: the catalogue table, the sub-event kind chain with any
// per-player suffix stripped, and whether these are the double-chance
// cells split off a match-winner table.
type MarketTypeKey struct {
	TableNum     int
	Variant      string
	DoubleChance bool
}

// MarketTypes is a loaded registry: our id in both directions.
type MarketTypes struct {
	byKey map[MarketTypeKey]int
	byID  map[int]MarketTypeKey
}

// playerSuffix is the trailing `:<playerId>` a per-player variant carries.
// That id is a PARAMETER, not part of the market type — 1 202 of the 1 264
// distinct live variants carry one, so folding it in would give every
// player their own type and grow the registry without bound. Such markets
// share a type and stay distinct rows because `variant` is part of
// specifiers_hash.
var playerSuffix = regexp.MustCompile(`:\d+$`)

// VariantKindChain strips the `fb:` tag and any per-player suffix off a
// raw specifiers.variant, leaving the sub-event kind chain. Mirrors
// variantKindChain in packages/types/src/market-kind.ts.
func VariantKindChain(variant string) string {
	v := strings.TrimSpace(variant)
	if v == "" {
		return ""
	}
	v = strings.TrimPrefix(v, "fb:")
	return playerSuffix.ReplaceAllString(v, "")
}

// KeyFor derives the registry key from a market the mapper built, which
// still carries the legacy composed id.
func KeyFor(m *mapper.Market) MarketTypeKey {
	tableNum, dc := mapper.MarketTypeOf(m.PMID)
	return MarketTypeKey{
		TableNum:     tableNum,
		Variant:      VariantKindChain(m.Specs["variant"]),
		DoubleChance: dc,
	}
}

// ID returns our provider_market_id for a key, if the registry holds one.
func (t *MarketTypes) ID(k MarketTypeKey) (int, bool) {
	if t == nil {
		return 0, false
	}
	id, ok := t.byKey[k]
	return id, ok
}

// Key returns the market type behind one of our ids — what the settlement
// grader needs, since it grades on the catalogue TABLE's name and can no
// longer derive the table by arithmetic.
func (t *MarketTypes) Key(providerMarketID int) (MarketTypeKey, bool) {
	if t == nil {
		return MarketTypeKey{}, false
	}
	k, ok := t.byID[providerMarketID]
	return k, ok
}

func (t *MarketTypes) Len() int {
	if t == nil {
		return 0
	}
	return len(t.byKey)
}

// LoadMarketTypes reads the whole registry. Small and bounded — 1 060 rows
// across 580 catalogue tables measured on production 2026-09-08 — so it is
// held in memory and refreshed rather than joined per market.
func LoadMarketTypes(ctx context.Context, db pgxRunner, provider string) (*MarketTypes, error) {
	rows, err := db.Query(ctx, `
SELECT provider_market_id, table_num, variant, double_chance
  FROM provider_market_types
 WHERE provider = $1`, provider)
	if err != nil {
		return nil, fmt.Errorf("load market types: %w", err)
	}
	defer rows.Close()
	out := &MarketTypes{byKey: map[MarketTypeKey]int{}, byID: map[int]MarketTypeKey{}}
	for rows.Next() {
		var (
			id  int32
			k   MarketTypeKey
			num int32
		)
		if err := rows.Scan(&id, &num, &k.Variant, &k.DoubleChance); err != nil {
			return nil, fmt.Errorf("scan market type: %w", err)
		}
		k.TableNum = int(num)
		out.byKey[k] = int(id)
		out.byID[int(id)] = k
	}
	return out, rows.Err()
}

// EnsureMarketTypes allocates ids for any keys the registry does not hold
// yet and returns the rows it created, so the caller can merge them in.
//
// Batched in one statement per cycle rather than one per market: a warm
// registry misses only when Fonbet publishes a sub-event we have never
// seen, which is rare, but the first cycle on an empty database misses
// every one of them.
//
// ON CONFLICT DO NOTHING then a re-read, because two ingester instances
// (or an instance racing the migration's own seed) must converge on ONE id
// per key — the unique constraint is the arbiter, not this code.
func EnsureMarketTypes(
	ctx context.Context,
	db pgxRunner,
	provider string,
	keys []MarketTypeKey,
) (map[MarketTypeKey]int, error) {
	out := map[MarketTypeKey]int{}
	if len(keys) == 0 {
		return out, nil
	}
	tables := make([]int32, 0, len(keys))
	variants := make([]string, 0, len(keys))
	dcs := make([]bool, 0, len(keys))
	for _, k := range keys {
		tables = append(tables, int32(k.TableNum))
		variants = append(variants, k.Variant)
		dcs = append(dcs, k.DoubleChance)
	}
	// The INSERT and the read-back are one statement so a key another
	// writer inserted concurrently still comes back with its id.
	rows, err := db.Query(ctx, `
WITH want AS (
  SELECT * FROM unnest($2::int[], $3::text[], $4::bool[])
    AS t(table_num, variant, double_chance)
), ins AS (
  INSERT INTO provider_market_types (provider, table_num, variant, double_chance)
  SELECT $1, table_num, variant, double_chance FROM want
  ON CONFLICT (provider, table_num, variant, double_chance) DO NOTHING
  RETURNING provider_market_id, table_num, variant, double_chance
)
SELECT provider_market_id, table_num, variant, double_chance FROM ins
UNION ALL
SELECT p.provider_market_id, p.table_num, p.variant, p.double_chance
  FROM provider_market_types p
  JOIN want w ON w.table_num = p.table_num
             AND w.variant = p.variant
             AND w.double_chance = p.double_chance
 WHERE p.provider = $1`, provider, tables, variants, dcs)
	if err != nil {
		return nil, fmt.Errorf("ensure market types: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id  int32
			num int32
			k   MarketTypeKey
		)
		if err := rows.Scan(&id, &num, &k.Variant, &k.DoubleChance); err != nil {
			return nil, fmt.Errorf("scan ensured market type: %w", err)
		}
		k.TableNum = int(num)
		out[k] = int(id)
	}
	return out, rows.Err()
}

// Merge folds newly allocated ids into a loaded registry.
func (t *MarketTypes) Merge(added map[MarketTypeKey]int) {
	if t == nil {
		return
	}
	for k, id := range added {
		t.byKey[k] = id
		t.byID[id] = k
	}
}

// MarketKind renders the readable key for a type — "fb:120@100201" — the
// same string packages/types/src/market-kind.ts produces and the registry
// stores as a generated column. For logs and for the api payload.
func MarketKind(provider string, k MarketTypeKey) string {
	tag := "od:"
	if provider == Provider {
		tag = "fb:"
	}
	out := tag + strconv.Itoa(k.TableNum)
	if k.Variant != "" {
		out += "@" + k.Variant
	}
	if k.DoubleChance {
		out += "#dc"
	}
	return out
}
