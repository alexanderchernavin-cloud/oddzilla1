# services/feed-ingester

Oddin AMQP consumer. Go 1.23 / `amqp091-go` + `encoding/xml` + `pgx/v5`.

**Phase 1:** boots, pings Postgres + Redis, serves `/healthz` on `:8081`.
**Phase 3 (current):** real AMQP consumer with auto-mapping, REST client
for recovery, Redis stream publishing. Gracefully idles (health-only) when
`ODDIN_TOKEN` / `ODDIN_CUSTOMER_ID` are absent — boot is safe without
credentials.

Sub-packages (see `internal/`):
- `oddinxml` — typed struct decoders + specifier canonicalization + URN
- `oddinrest` — HTTP client with `x-access-token`, retry, snapshot endpoint
- `amqp` — connection loop with exponential-backoff reconnect
- `store` — pgx queries for markets, outcomes, odds_history, catalog, amqp_state
- `automap` — unknown-entity creation + mapping_review_queue
- `bus` — Redis Streams `XADD odds.raw` adapter
- `handler` — top-level dispatcher + per-message-type handlers
- `config` — env parsing

See [`../../docs/ODDIN.md`](../../docs/ODDIN.md) for the protocol details
and [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for the data
flow.

## Run

```bash
go run ./cmd/feed-ingester                 # local
docker compose up --build feed-ingester    # via compose
```

## Layout (target, phase 3)

```
cmd/feed-ingester/main.go
internal/
├─ amqp/              connection mgmt, prefetch, reconnect, backoff
├─ oddinxml/          encoding/xml structs + decoders
│  └─ specifiers.go   MIRROR of packages/types/src/specifiers.ts
├─ oddinrest/         HTTP client with x-access-token, snapshot recovery
├─ store/             pgx writes: markets, market_outcomes, odds_history,
│                     mapping_review_queue, amqp_state
├─ automap/           unknown sport/tournament → create + queue review
├─ bus/               Redis Streams abstraction (XADD odds.raw)
└─ config/            env parsing (fail-fast)
```

## Invariants

- **Specifier canonicalization must match the TS implementation byte-for-byte.**
  Shared golden-test fixture in both repos. If they drift, settlement
  silently fails.
- **Debounce and batch.** Up to 200 msg/s/match during live. Debounce 100 ms
  per `(market_id)` and flush in `UPDATE ... FROM (VALUES ...)` form.
- **Persist `after_ts` before each flush** so crashes don't lose cursor.
- **Never block on Redis.** If XADD fails, log + continue — Postgres is the
  source of truth and odds-publisher will re-publish on next change.
