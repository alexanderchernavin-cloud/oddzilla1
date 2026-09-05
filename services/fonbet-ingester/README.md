# services/fonbet-ingester

Second odds provider: the public **Fonbet** line (traditional sports),
read from **fon.bet in English** by default.
Go 1.23 / `net/http` + `encoding/json` + `pgx/v5` + `go-redis`. Writes the
same tables and Redis stream as `feed-ingester`, so odds-publisher,
ws-gateway and the storefront serve Fonbet matches unchanged.

No credentials are needed — the line is public. Whether the feed runs is
decided by the **Fonbet feed** switch on `/admin/feed`
(`feed_control.fonbet_enabled`, migration 0099), read every 2 s by the
`switchWatcher` in `cmd/fonbet-ingester/main.go`; `FONBET_ENABLED` is only
the default while nothing was ever set there. Off = `SuspendAll` + stop
polling + settlement worker stopped (the service keeps serving `/healthz`
and the `fonbet:feed:status` Redis hash); On = `runFeed` boots the
catalogue, previous state and workers in place. A boot failure while On
retries every 30 s instead of exiting, so the container never crashloops on
a Fonbet outage.

## Site and language

Defaults read `fon.bet` in English (`FONBET_SITE_ORIGIN`,
`FONBET_URLS_JSON`, `FONBET_LINE_HOSTS`, `FONBET_COMMON_HOSTS`,
`FONBET_LOGO_CDN`, `FONBET_SCOPE_MARKET`, `FONBET_LANG`). The Kazakhstan
estate `fonbet.kz` serves the **same line** — same event ids, same
catalogue table numbers, same outcome ids — so switching between them
changes no market identity, only display text; `.env.example` carries the
full KZ variable set. `scopeMarket` is per site (1600 fon.bet /
1800 fonbet.kz) and each 404s on the other's value, and the host lists are
the trust anchor for `urls.json` discovery, so the site vars move as a set.

`FONBET_LANG` is **not** display-only: the settlement grader
(`internal/settle`) reads the catalogue table names, the sub-event labels
and the results feed in that language. `rules.go` carries English and
Russian vocabularies; anything else leaves it unable to recognise periods,
statistic rows, or the market shapes it must refuse.

To check the configured site end to end with no database — host
discovery, snapshot, both catalogues, logos, one day of results:

```bash
go test -tags livesmoke ./internal/fonbet/ -run TestLiveSmoke -v
```

**Read [`../../docs/FONBET.md`](../../docs/FONBET.md) before enabling on
prod.** Settlement is graded from Fonbet's results feed (`internal/settle`)
and applied by `services/settlement`, and it is gated by its OWN switch:
`FONBET_SETTLE_ENABLED` defaults to `false` independently of
`FONBET_ENABLED`, so the feed can run alone while the grader is soaked on
staging ("Before enabling settlement" in the doc). Until it is on, Fonbet
markets stay open after the final whistle for manual settlement.

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

1. `GET <line>/events/list?lang=en&version=0&scopeMarket=1600` (~1 MB gz).
2. `mapper.Build` → matches with markets keyed by
   `(provider_market_id, canonical specifiers)`.
3. `ingest.Apply` diffs against the in-memory previous snapshot (seeded
   from Postgres at boot): new / re-statused markets → `UpsertMarketsBulk`,
   changed outcomes → `UpsertOutcomesBulk` + `XADD odds.raw` + odds_history,
   vanished outcomes → deactivated, vanished markets → `status 0` (or `-1`
   while the event is blocked), vanished live matches → `closed`.
4. `marketStatus` / `matchStatus` / `score` frames on `odds:match:{id}`.

Logos ride alongside, refreshed every 10 min and applied right after a
cycle (only `logo_url IS NULL` rows, so an operator upload always wins).
Tournaments have **two** upstream sources and `ingest.ApplyLogos` merges
them, `line/logos` winning: its `competitions` map is keyed by segment id,
and `fonbet.Client.TournamentIcons` reads the `tournamentInfos` block off
the snapshot from step 1 (free — no extra request) for the marks that map
has none of. Country flags are dropped from the second source on purpose;
Fonbet has a real mark for only about half its leagues and falls back to
the flag, which the storefront already shows on the category header. See
[docs/FONBET.md](../../docs/FONBET.md#tournament-marks--coverage-and-why-half-the-rows-have-none).

## Invariants

- **Specifier canonicalization is byte-identical** to the TS + Go copies
  (`internal/specifiers/specifiers_test.go` runs the shared golden file).
- **Never revive terminal markets** — every status write is guarded by
  `status NOT IN (-3, -4)`.
- **Never block on Redis.** XADD / publish failures are logged; Postgres is
  the source of truth and the next diff re-emits.
- **Only `fb:` URNs are touched** by the staleness / shutdown suspend.
- **Full-snapshot semantics.** Whatever Fonbet omits is off the offer.
- **State never runs ahead of Postgres.** A match whose writes fail is
  dropped from memory and re-asserted in full on the next cycle.
- **No single-tick closes.** A known match must be absent from
  `MissingCyclesToClose` (3) consecutive snapshots before it is closed /
  deactivated, and a snapshot with fewer than half the previously applied
  matches is rejected as partial data. Both compare the PRE-cap match count
  (`Snapshot.TotalMatches`); events cut by `FONBET_MAX_MATCHES` are listed
  in `Snapshot.Capped` and never treated as vanished.
- **`odds.raw` MAXLEN equals feed-ingester's (100k) and stays there.** The
  cold-start republish paces itself on odds-publisher's group lag
  (`bus.OddsBacklog` / `ingest.waitForOddsBacklog`, high-water 50k, bounded
  wait) rather than asking for a bigger stream — Redis is 256 MB total.
- **Only https hosts under the operator's configured domains** are adopted
  from `urls.json` (`fonbet.normalizeHosts`); the rest are logged and
  ignored. The document is third-party input that decides where prices
  and results are fetched from.
- **A settle message is remembered as emitted only after it is on the
  stream.** A failed XADD is returned as an error and the next pass retries
  every unsent market.
- **`sports.slug` collisions do not wedge a sport.** `EnsureSport` retries
  with an `-fb-<id>` suffix when `sports_slug_key` fires (the
  `(provider, provider_urn)` ON CONFLICT does not cover it).
