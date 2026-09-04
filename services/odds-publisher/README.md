# services/odds-publisher

Applies the payback margin and fans out to browsers via Redis pub/sub.
Go 1.23 / `pgx/v5` + `go-redis/v9`.

**Phase 1:** health stub on `:8082`.
**Phase 4 (current):** full publisher — XREADGROUP consumer group, margin
cascade, Postgres writes, Redis pub/sub fanout. Boots before the ingester
too (creates stream via MKSTREAM).

Sub-packages (`internal/`):
- `bus` — XREADGROUP consumer, XACK, XAUTOCLAIM for dead-replica recovery
- `publisher` — margin math + DB writes + pub/sub
- `store` — market lineage (batched `ResolveMarkets`, LRU of 131072) +
  margin cascade (cached, 5s TTL); `bulk.go` holds the per-batch writes
- `config` — env parsing

## Flow

1. `XREADGROUP` from Redis stream `odds.raw` (written by `feed-ingester`
   and `fonbet-ingester`).
2. Look up margin from `odds_config` with cascade: `market_type → tournament
   → sport → global`; first match wins.
3. `published_odds = raw_odds / (1 + margin_bp / 10000)`.
4. Per XREADGROUP batch: one `UPDATE market_outcomes ... FROM UNNEST`
   (last tick per outcome wins — duplicates within a batch are
   collapsed first) and one `INSERT INTO odds_history` for every tick
   (raw + published snapshot).
5. Pipelined `PUBLISH odds:match:{match_id}` with a compact JSON payload
   per tick for `ws-gateway`.

## Run

```bash
go run ./cmd/odds-publisher
```

## Invariants

- Pub/sub is best-effort. Postgres `published_odds` is the source of truth
  on WS reconnect.
- Margin changes in `odds_config` trigger a full republish of affected
  matches (handled by admin action in phase 4).
- Postgres writes are batched per XREADGROUP batch (`ODDS_PUBLISHER_BATCH`,
  default 128) — the per-event loop topped out near 250 ticks/s, which the
  Fonbet line (~300 changes/s) overran.
- `ODDS_HISTORY_SKIP_PMID_MIN` (default 0 = off) is the operator brake on
  `odds_history` growth: ticks with `provider_market_id >=` the value skip
  the history INSERT while `published_odds` still updates. `1000000` covers
  the Fonbet namespace. Sizing rule in docs/OPERATIONS.md "odds_history
  retention".
- `ODDS_PUBLISHER_GROUP` is also read by fonbet-ingester, which watches this
  group's lag (`XINFO GROUPS odds.raw`) to pace its cold-start republish;
  keep the two services on the same value.
