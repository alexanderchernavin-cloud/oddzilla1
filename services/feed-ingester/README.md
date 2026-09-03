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

## Backup inputs (Bifrost)

Two additions ride alongside the AMQP path; see
[`docs/BIFROST_BACKUP_FEED.md`](../../docs/BIFROST_BACKUP_FEED.md).

- `internal/backupstream` consumes the `oddin.backup` Redis stream written
  by `services/bifrost-feed` (consumer group `feed-ingester`, routing key
  `bifrost.backup`). Entries are Oddin-shaped `odds_change` /
  `fixture_change` documents and go through the same `handler.Handle`.
  They never bump `lastAmqpMessageUnix`: that counter, mirrored to Redis
  `feed:primary:last_msg_unix` at most once per second by the AMQP
  handler, is the primary-liveness signal both the alive watchdog and the
  backup's gate key off. `BACKUP_STREAM_ENABLED=false` detaches it.
- `internal/bifrost` is the auto-mapper's second fixture source. When the
  REST fixture lookup fails, `automap.Resolver.fetchFixtureAny` asks
  Bifrost's `match` query and reshapes it into the same
  `oddinxml.FixtureResponse`, and seeds `competitor_profiles` icons from
  the team data. Enabled when `BIFROST_API_KEY` is set.
- `runSourceSwitch` (main.go) polls Redis `feed:source`, the backoffice
  Feed source switch. `backup`: keep the AMQP connection and its liveness
  stamps but ack deliveries without applying them, suspend the catalogue
  once, acknowledge with `feed:source:flushed_unix` (bifrost-feed waits
  for it before re-emitting). Back to `auto` / `prod`: reconnect-style
  flush + 24 h replay, then resume applying. A boot-time `backup` value
  is adopted without a flush. `/healthz` reports `feedSource` and
  `amqpApplied`. While on `backup` no Oddin feed REST endpoint is called:
  the resolver's REST gate sends fixtures to Bifrost and skips tournament
  info / competitor profiles, descriptions refresh + competitor backfill
  + recovery requests are skipped, an AMQP reconnect neither flushes nor
  replays, and the alive watchdog guards bifrost-feed's heartbeat and
  socket instead of AMQP. Switching back re-enables REST and immediately
  refreshes descriptions + competitor profiles.
- Backup-sourced `odds_change` documents carry `name` on markets (the
  Bifrost group name; seeds `market_descriptions` when no row exists) and
  on outcomes (selection names → `market_outcomes.name`; player URNs also
  seed `player_profiles`). Oddin's own messages carry neither, so the
  seeding is a no-op for the primary path, and REST overwrites the seeds
  on its next refresh.
- `store.UpdateTournamentRiskTier` skips rows with `risk_tier_locked`
  (migration 0094): an operator-assigned tier on `/admin/tournaments`
  survives the per-fixture refresh and `-backfill-tournament-metadata`.
