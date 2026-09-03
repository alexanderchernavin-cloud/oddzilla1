# services/fonbet-ingester

Second odds provider: the public **Fonbet KZ** line (traditional sports).
Go 1.23 / `net/http` + `encoding/json` + `pgx/v5` + `go-redis`. Writes the
same tables and Redis stream as `feed-ingester`, so odds-publisher,
ws-gateway and the storefront serve Fonbet matches unchanged.

Gracefully idles (health only) unless `FONBET_ENABLED=true`. No
credentials are needed — the line is public.

**Read [`../../docs/FONBET.md`](../../docs/FONBET.md) before enabling on
prod:** Fonbet markets have no settlement path yet.

## Run

```bash
go run ./cmd/fonbet-ingester                                   # local
docker compose -f docker-compose.yml -f docker-compose.dev.yml up fonbet-ingester
go test ./...                                                  # unit tests (fixtures under internal/mapper/testdata)
```

`/healthz` on `HEALTH_PORT` (default 8087) reports db / redis, the last
snapshot time, staleness, match + outcome counts and whether the watchdog
has suspended the catalog.

## Layout

```
cmd/fonbet-ingester/main.go   boot, poll loop, watchdog, health
internal/
├─ config/        env parsing (FONBET_* — see .env.example)
├─ fonbet/        HTTP client (urls.json host discovery, gzip, host rotation),
│                 wire types, factor catalogue index (table → param kind,
│                 match-winner detection, labels)
├─ mapper/        pure snapshot → Match / Market / Outcome mapping,
│                 static sport table (slug + name), slugify, description
│                 templates; tests on real Fonbet fixtures
├─ ingest/        previous-snapshot diff, pg + Redis writes, lifecycle,
│                 live score payload, staleness suspend
├─ store/         pgx SQL (copies of feed-ingester's, provider='fonbet')
├─ bus/           Redis Streams / pub-sub adapter (copy of feed-ingester's)
└─ specifiers/    MIRROR of packages/types/src/specifiers.ts (golden-tested)
```

## Cycle

1. `GET <line>/events/list?lang=ru&version=0&scopeMarket=1800` (~1 MB gz).
2. `mapper.Build` → matches with markets keyed by
   `(provider_market_id, canonical specifiers)`.
3. `ingest.Apply` diffs against the in-memory previous snapshot (seeded
   from Postgres at boot): new / re-statused markets → `UpsertMarketsBulk`,
   changed outcomes → `UpsertOutcomesBulk` + `XADD odds.raw` + odds_history,
   vanished outcomes → deactivated, vanished markets → `status 0` (or `-1`
   while the event is blocked), vanished live matches → `closed`.
4. `marketStatus` / `matchStatus` / `score` frames on `odds:match:{id}`.

## Invariants

- **Specifier canonicalization is byte-identical** to the TS + Go copies
  (`internal/specifiers/specifiers_test.go` runs the shared golden file).
- **Never revive terminal markets** — every status write is guarded by
  `status NOT IN (-3, -4)`.
- **Never block on Redis.** XADD / publish failures are logged; Postgres is
  the source of truth and the next diff re-emits.
- **Only `fb:` URNs are touched** by the staleness / shutdown suspend.
- **Full-snapshot semantics.** Whatever Fonbet omits is off the offer.
