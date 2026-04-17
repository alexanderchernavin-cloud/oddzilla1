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
- `store` — market metadata + margin cascade (cached, 5s TTL)
- `config` — env parsing

## Flow

1. `XREADGROUP` from Redis stream `odds.raw` (written by `feed-ingester`).
2. Look up margin from `odds_config` with cascade: `market_type → tournament
   → sport → global`; first match wins.
3. `published_odds = raw_odds / (1 + margin_bp / 10000)`.
4. `UPDATE market_outcomes SET published_odds=...` and
   `INSERT INTO odds_history` (raw + published snapshot).
5. `PUBLISH odds:match:{match_id}` with a compact JSON payload for
   `ws-gateway`.

## Run

```bash
go run ./cmd/odds-publisher
```

## Invariants

- Pub/sub is best-effort. Postgres `published_odds` is the source of truth
  on WS reconnect.
- Margin changes in `odds_config` trigger a full republish of affected
  matches (handled by admin action in phase 4).
- Batch Postgres writes per market to stay ahead of the stream.
