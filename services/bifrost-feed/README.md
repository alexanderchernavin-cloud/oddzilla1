# services/bifrost-feed

Backup odds and settlement feed. Consumes Oddin's **Bifrost** GraphQL API
(the white-label esports front end behind `maxbet.rs/en/esport`) and
re-synthesises the Oddin AMQP message shapes feed-ingester and settlement
already understand. Standby by default; publishes only while the primary
AMQP feed is silent.

Full design, protocol notes and gaps: [`docs/BIFROST_BACKUP_FEED.md`](../../docs/BIFROST_BACKUP_FEED.md).

## What it does

```
Bifrost (wss + https) ──► runner ──► translate ──► Redis stream `oddin.backup`
                                                     ├─► feed-ingester  (odds_change, fixture_change)
                                                     └─► settlement     (bet_settlement)
```

- One WebSocket (graphql-transport-ws) carries one `onUpdateMatchLive`
  subscription per match on the active esports offer plus the global
  `onMatchStateChanged` stream. Every frame is a full match snapshot.
- `translate` renders a snapshot as `odds_change` (open / suspended
  markets, live score, lifecycle code) and `bet_settlement` (markets
  Bifrost has CLOSED with terminal outcome statuses).
- `dbstate` gates settlement: a market is voiced only if it exists in our
  Postgres and is not already `-3` / `-4` there. No local "already sent"
  state is ever authoritative, so restarts and reconnects converge.
- `gate` reads `feed:primary:last_msg_unix` (stamped by feed-ingester on
  every AMQP delivery). `auto` mode publishes after
  `BIFROST_TAKEOVER_AFTER_SECONDS` of silence and stands down the moment
  the stamp is fresh again; `active` forces publishing; `off` idles.
- On activation every cached snapshot is re-emitted so the catalogue the
  alive watchdog suspended comes back in one pass. Every
  `BIFROST_RESYNC_INTERVAL_SECONDS` the runner re-lists the offer and
  sweeps the last three hours of results for settlements our DB lacks.

## Layout

| Path | Purpose |
| --- | --- |
| `cmd/bifrost-feed` | boot, health, status hash, `-dry-run` |
| `internal/bifrost` | HTTP + WS GraphQL clients, wire types, id decoding, the four query documents |
| `internal/translate` | snapshot → Oddin XML; unit-tested against the consumer-side structs |
| `internal/gate` | primary-liveness gate |
| `internal/publisher` | Redis stream + status hash; dry-run logger |
| `internal/dbstate` | "is this market still open in our DB" probe |
| `internal/feed` | runner (subscriptions, resync, activation re-emit) |

## Env

| Var | Default | Meaning |
| --- | --- | --- |
| `BIFROST_API_KEY` | empty | brand key; empty = idle. Oddin authorised MaxBet's key (client 101) on 2026-09-03 |
| `BIFROST_API_URL` | `https://api-bifrost.oddin.gg/main/bifrost/query` | GraphQL endpoint; `BIFROST_WS_URL` derives from it |
| `BIFROST_LOCALE` | `en` | `X-Locale` header |
| `BIFROST_ORIGIN` | `https://bifrost.oddin.gg` | `Origin` header; must be a host the key is registered for |
| `BIFROST_MODE` | `auto` | `auto` / `active` / `off` |
| `BIFROST_TAKEOVER_AFTER_SECONDS` | `45` | AMQP silence before auto mode publishes |
| `BIFROST_RESYNC_INTERVAL_SECONDS` | `300` | offer re-list + results sweep cadence |
| `BIFROST_SUBSCRIPTION_BATCH` | `50` | subscribes per write burst |
| `HEALTH_PORT` | `8086` | `/healthz` (compose maps `BIFROST_FEED_HEALTH_PORT`) |

Plus `DATABASE_URL`, `REDIS_URL`, `LOG_LEVEL`, `SERVICE_NAME` like every other Go service.

## Run

```bash
# inside the stack
docker compose up bifrost-feed

# translation check against live Bifrost, no Postgres / Redis
BIFROST_API_KEY=... go run ./cmd/bifrost-feed -dry-run -dry-run-seconds 90

go vet ./... && go test ./...
```

`/healthz` returns the gate state and runner counters; the same numbers
land in Redis hash `bifrost:feed:status` for the backoffice card on
`/admin/feed`.

## Known gaps (tracked in docs/BIFROST_BACKUP_FEED.md)

- No `bet_cancel` / `rollback_*` synthesis. Bifrost shows no cancel
  state; a cancelled event appears as CLOSED with its markets removed.
- Probabilities are derived from odds (margin-normalised implied
  probability), not Oddin's own model output.
- Tournament risk tier is not on Bifrost; assign it in `/admin/tournaments`.
