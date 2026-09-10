# services/slotzilla

The engine behind **SlotZilla**, the 15-second live-basketball slot
(design and measurements: [`../../docs/SLOTZILLA.md`](../../docs/SLOTZILLA.md)).
Go 1.23 / `net/http` + `encoding/json` + `pgx/v5` + `go-redis` + `zerolog`.

A bettor presses Spin on a live basketball match (the api places the spin
and locks the stake). The spin covers 15 seconds of MATCH CLOCK on a fixed
5-second grid; each window becomes a reel showing the highest-value
play-by-play event inside it (P3 > P2 > FT > MISS > FOUL > NONE), and two
or three reels on one symbol pay from the paytable the spin was placed
under. This service is everything after placement:

- **Games.** Every basketball fixture with a CONFIRMED row in
  `match_sportradar_ids` (sport 2) that is live or within an hour of
  kickoff gets a `slotzilla_games` row (`scheduled` -> `live` -> `ended`).
  No mapping, no game.
- **Feed.** Sportradar's open statistics host, no credential; the host
  403s a bare client, so the client sends a browser User-Agent. Per game:
  `match_timelinedelta/<id>` every poll (3 s), the full `match_timeline`
  on first sight and every reconcile interval (60 s) to pick up scout
  corrections (`updated_uts`, `disabled`).
- **Events.** Upserted into `sr_live_events` keyed on Sportradar's event
  id, with the symbol derived ONCE by `internal/rules` (the Go port of
  `packages/types/src/slotzilla.ts`; both are pinned against
  `docs/fixtures/slotzilla-rules.json`). Events with `seconds < 0` (no
  clock reading) are skipped.
- **Windows.** Rebuilt in memory from the stored events whenever a poll
  changes one; published as a `slotzilla_state` frame on
  `odds:match:<matchId>` (ws-gateway fans it out) and cached under
  `slotzilla:state:<matchId>` (EX 120) for the api's GET. A window is
  `final` once the clock is `clock_past_seconds` past it (dropped once the
  match has ended, when the clock will not move again) AND
  `grace_seconds` of wall time have passed since the last event in it
  reached us.
- **Settlement.** A spin whose three windows are final settles in ONE
  transaction (`internal/store/spins.go`): the row is frozen (guarded on
  `status = 'open'`), the `(user, currency)` wallet releases the lock and
  moves by `payout - stake`, a `slot_payout` ledger row rides the
  wallet_ledger unique partial index (apply-once), RiskZilla's open
  liability is released for USDC only, and the game's payout total grows.
  The bettor gets a `slotzilla_spin` frame on `user:<id>`.
- **Voids.** Feed dark for `feed_dark_void_seconds` (`feed_dark`, and a
  live game is parked as a service pause that lifts itself when the feed
  answers again), fixture cancelled (`match_cancelled`, game `voided`),
  fixture over with windows the clock never reached (`match_ended`). A
  void releases the lock with the balance unchanged and writes a
  `slot_refund` row.

## Switches

| Where | What |
| --- | --- |
| `slotzilla_config.enabled` (Postgres, `/admin/slotzilla`) | The runtime switch, re-read every 5 s. Off = the service idles: health and the status hash only. |
| `SLOTZILLA_DISABLED=true` (env) | Parks the process regardless of the database switch. |

An operator's pause (`paused_by` set) is never touched by the service; a
paused game still settles its open spins and accepts no new ones.

## Env

`DATABASE_URL`, `REDIS_URL` (required); `HEALTH_PORT` (8088), `LOG_LEVEL`,
`SERVICE_NAME`, `SLOTZILLA_POLL_INTERVAL_MS` (3000),
`SLOTZILLA_RECONCILE_INTERVAL_MS` (60000), `SLOTZILLA_STATS_BASE`,
`SLOTZILLA_HTTP_TIMEOUT_MS` (10000), `SLOTZILLA_MAX_CONCURRENT_FETCHES` (8),
`SLOTZILLA_DISABLED`. See `.env.example`.

## Layout

```
cmd/slotzilla          boot, health server, idle mode
internal/config        env parsing
internal/rules         the game rules (Go port, golden-fixture tested)
internal/sportradar    HTTP client + timeline parser (fixtures under testdata/)
internal/store         all SQL, one function per statement; the two money txs
internal/engine        per-game state machine, windows, final predicate, frames
internal/bus           Redis publish / state cache / status hash
```

## Run

```bash
go run ./cmd/slotzilla                                       # local
docker compose -f docker-compose.yml -f docker-compose.dev.yml up slotzilla
go vet ./... && go test ./...                                # no database needed
```

`/healthz` reports db + redis, the config switch, the game counts, the
last successful fetch and the last error; the same figures land in the
Redis hash `slotzilla:feed:status` after every tick.
