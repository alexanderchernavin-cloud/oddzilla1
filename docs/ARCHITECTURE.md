# Architecture

Deep dive on how Oddzilla's services fit together. For quick reference see
[`../CLAUDE.md`](../CLAUDE.md). For the Oddin protocol details see
[`ODDIN.md`](./ODDIN.md). For the DB, see [`SCHEMA.md`](./SCHEMA.md).

## System diagram

```
                   ┌──────────────────────────────┐
                   │  Oddin.gg (external feed)    │
                   │   AMQPS :5671 + REST HTTPS   │
                   └──────────────┬───────────────┘
                                  │ XML
                                  ▼
 ┌────────────────────────────────────────────────────────────┐
 │  feed-ingester (Go)                                        │
 │   • AMQP consumer — topic exchange, prefetch 256           │
 │   • encoding/xml decoders for odds_change, fixture_change, │
 │     bet_stop, alive, snapshot_complete                      │
 │   • Auto-map unknown sport/tournament/match/market         │
 │   • On disconnect: REST snapshot since amqp_state.after_ts │
 │   • Specifier canonicalization (sha256 → specifiers_hash)  │
 │   • Batches: UPSERT market_outcomes, INSERT odds_history   │
 └─────┬────────────────────────────────────────────┬─────────┘
       │ Postgres UPSERT                           │ XADD odds.raw
       ▼                                            ▼
 ┌─────────────────┐                     ┌────────────────────┐
 │  Postgres 16    │                     │  Redis 7 streams   │
 │  (source of     │◄──── XREADGROUP ────│  odds.raw          │
 │   truth for all │                     └─────────┬──────────┘
 │   persistent    │                               │
 │   state)        │                               ▼
 └─────┬───────────┘               ┌───────────────────────────┐
       │                           │ odds-publisher (Go)       │
       │                           │  • Read odds_config       │
       │                           │    cascade (global→sport  │
       │                           │    →tournament→market)    │
       │                           │  • Apply payback margin   │
       │                           │  • UPDATE published_odds  │
       │                           │  • PUBLISH Redis pub/sub  │
       │                           │    odds:match:{id}        │
       │                           └─────────┬─────────────────┘
       │                                     │
       │                                     ▼
       │                          ┌────────────────────────────┐
       │                          │  Redis pub/sub (best-effort)│
       │                          └────────────┬───────────────┘
       │                                       │ SUBSCRIBE
       │                                       ▼
       │                          ┌────────────────────────────┐
       │                          │  ws-gateway (TS, ws lib)   │
       │                          │   • JWT on connect         │
       │                          │   • Per-client sub table   │
       │                          │   • 5 msg/s token bucket   │
       │                          └────────────┬───────────────┘
       │                                       │ WS frames
       │                                       ▼
       │                          ┌────────────────────────────┐
       │◄─────── HTTP ────────────│  apps/web (Next.js 16)     │
       │ (catalog SSR, bet slip,  │   • Tailwind v4 dark theme │
       │  history, admin UI)      │   • App Router             │
       │                          │   • WS client reconnect    │
       │                          └────────────┬───────────────┘
       │                                       │
       │                                       ▼
       │                          ┌────────────────────────────┐
       │◄─── Fastify REST ────────│  services/api (TS)         │
       │                          │   /auth /users /wallet     │
       │                          │   /bets /catalog /admin    │
       │                          │   /news                    │
       │                          └────────────┬───────────────┘
       │                                       │ pg_notify('bet_delay')
       │                                       ▼
       │                          ┌────────────────────────────┐
       │────UPDATE tickets───────►│  bet-delay (Go)            │
       │                          │   LISTEN + periodic sweep  │
       │                          │   Re-read published_odds;  │
       │                          │   drift > tolerance→reject │
       │                          └────────────────────────────┘
       │
       │                          ┌────────────────────────────┐
       │                          │  settlement (Go)           │
 Oddin─┼──AMQP bet_settlement────►│   apply-once per           │
       │         bet_cancel       │   (event,market,specs,type,│
       │         rollback_*       │    payload) → tickets →    │
       │                          │   wallets + wallet_ledger  │
       │                          └────────────────────────────┘
       │
       │                          ┌────────────────────────────┐
       │                          │  wallet-watcher (Go)       │
       │◄─────INSERT deposits─────│   Tron: gotron-sdk blocks  │
       │                          │   ETH:  go-ethereum Transfer│
       │                          │   N confirmations → credit │
       │                          │   wallet_ledger (ref_id =  │
       │                          │   deposit.id, dedup unique)│
       │                          └────────────────────────────┘
       │
       │                          ┌────────────────────────────┐
       │◄─────INSERT news─────────│  news-scraper (TS cron)    │
       │                          │   HLTV RSS, Liquipedia     │
       │                          │   (phase 8)                │
       │                          └────────────────────────────┘
```

## Data flow walkthroughs

### Odds update

1. Oddin publishes `odds_change` XML on a topic exchange. Routing key encodes
   priority, pre/live, message type, sport, URN, event id, node.
2. `feed-ingester` decodes the XML, canonicalizes specifiers
   (`k1=v1|k2=v2`, sorted, sha256), upserts `markets` and `market_outcomes`
   (`raw_odds`), and appends one row per outcome to `odds_history`.
3. Same goroutine XADDs a message to Redis stream `odds.raw` containing the
   market id, outcome id, raw odds, and timestamp — so downstream doesn't
   have to re-read from Postgres.
4. `odds-publisher` XREADGROUPs from `odds.raw`. It looks up the applicable
   `odds_config` row (cascade: market_type → tournament → sport → global) and
   applies the payback margin: `published = raw / (1 + margin_bp/10000)`.
   Writes `market_outcomes.published_odds` + one row in `odds_history`.
5. It PUBLISHes the result on Redis pub/sub channel `odds:match:{match_id}`.
6. `ws-gateway` holds an ioredis subscriber. For each connected WS client it
   tracks which matches they subscribed to. When a message arrives, it fans
   it out — clipped to 5 msg/s/client by a token bucket to protect the
   Hetzner box from runaway fanout costs.
7. Browser JS updates the DOM; odds values animate with a brief highlight.

**Recovery on reconnect:** the frontend fetches the current `published_odds`
from the REST API, then reopens the WS and resubscribes. Pub/sub drops are
therefore safe.

### Bet placement

1. Client builds a slip, submits `POST /bets` with a client-generated
   `idempotencyKey` body field (NOT a header), stake in micro-USDT, and
   the market/outcome/odds for each selection.
2. `services/api` validates inside one transaction (with
   `SELECT FOR UPDATE` on the user + wallet rows): user is active, stake
   > 0, stake ≤ `balance - locked` (available), stake ≤
   `users.global_limit_micro` (if set), each market is `status=1` (active),
   each outcome is `active=true` and has a current `published_odds`,
   submitted odds within ±5% (default `DEFAULT_ODDS_DRIFT_TOLERANCE`)
   of current.
3. Same transaction:
   - Idempotency short-circuit: if `idempotencyKey` already exists for
     this user, return the existing ticket — no double-spend.
   - Insert `tickets` (status `pending_delay` if user has
     `bet_delay_seconds > 0`, else `accepted`).
   - Insert `ticket_selections` rows (one per selection).
   - `UPDATE wallets SET locked_micro = locked_micro + stake`.
   - `INSERT wallet_ledger (type='bet_stake', ref_type='ticket',
      ref_id=ticket.id, delta_micro=-stake)` — unique partial index makes
     a replay a no-op.
   - If delayed: `pg_notify('bet_delay', ticket.id::text)`.
4. After commit (best-effort): `Redis PUBLISH user:{userId}` with the
   ticket frame so the slip UI updates without polling. Failures here
   are logged and ignored — DB is source of truth.
5. `services/bet-delay` (Go) processes pending_delay tickets via two
   parallel paths:
   - Dedicated pooled connection LISTENing on `bet_delay`.
   - 1 s sweep selecting `tickets WHERE status='pending_delay' AND
     not_before_ts <= now()` (belt + suspenders against missed NOTIFYs).
   For each ticket: `FOR UPDATE SKIP LOCKED` (so multiple replicas
   share work), reload `published_odds` for each selection, evaluate:
   any market not `status=1` → `market_suspended`; any outcome
   `active=false` → `outcome_inactive`; any current odds drift > 5%
   from `odds_at_placement` → `odds_drift_exceeded`. Reject path:
   release lock, write a `bet_refund` ledger row keyed on the ticket
   id (replay-safe). Accept path: flip to `accepted`. Both paths
   publish `{type:'ticket', status, rejectReason?}` on
   `user:{userId}` for live UI updates.

### Settlement

1. Oddin publishes `bet_settlement` (or `bet_cancel` / `rollback_*`) XML on
   the AMQP topic.
2. `services/settlement` decodes, computes specifiers_hash with the same
   canonicalization, and executes a single DB transaction:
   ```sql
   INSERT INTO settlements (event_urn, market_id, specifiers_hash, type,
                            payload_hash, payload_json)
     ON CONFLICT (event_urn, market_id, specifiers_hash, type, payload_hash)
     DO NOTHING
     RETURNING id;
   ```
3. If no row returned → replay → ack AMQP → exit.
4. Else: bump `markets.status` to -3 (settled) or -4 (cancelled), update
   `market_outcomes.result` + `void_factor`, update every
   `ticket_selection` on that market whose `result IS NULL`, then for every
   ticket whose selections are all resolved:
   - compute `actual_payout_micro = stake × ∏ effective_factor` where
     `effective_factor = (1 - vf) × (result × odds) + vf` per selection.
     For singles: `won → odds`, `lost → 0`, `void → 1`,
     `half_won → (odds + 1)/2`, `half_lost → 0.5`. 15 unit tests in
     `services/settlement/internal/settler/payout_test.go` lock the math.
   - `UPDATE tickets SET status='settled', actual_payout_micro=...,
      settled_at=NOW()`,
   - `UPDATE wallets SET locked_micro -= stake,
      balance_micro += (payout - stake)`,
   - `INSERT wallet_ledger (type='bet_payout' OR 'bet_refund' for void,
      ref_type='ticket', ref_id=ticket.id, delta_micro=+payout)` — the
      unique partial index on `(type, ref_type, ref_id)` dedupes replays
      at the row level, so even if the settlements 5-tuple dedupe check
      were bypassed we still can't double-pay.
5. Commit, then publish `{type:'ticket', status:'settled'}` on
   `user:{userId}`. On any error the transaction aborts, AMQP is nacked
   with requeue.

**Rollback messages** (`rollback_bet_settlement`, `rollback_bet_cancel`)
insert their own `settlements` row (apply-once still applies — replays
of a rollback are also no-ops), reverse selection results
(`UPDATE ticket_selections SET result=NULL, void_factor=NULL`), restore
market status to 1 (active), reverse wallet movements via a compensating
`wallet_ledger (type='adjustment', ref_id=ticket.id, delta=-prior_payout)`
row — note the type is `adjustment` so it can coexist with the original
`bet_payout` row in the unique partial index. An `admin_audit_log` row
describes the rollback. Processed in 100-ticket chunks per transaction
to keep lock contention bounded.

**Manual void** (admin via `POST /admin/tickets/:id/void`) is the
operator escape hatch for an `accepted` ticket: full stake refund,
`status='voided'`, audit-logged. Cannot void already-settled tickets —
those go through Oddin's rollback flow.

### Wallet deposit

1. First call to `GET /wallet/deposit-addresses` from the API derives both
   addresses for the user. The user's BIP32 child index is
   `userIndexFromUUID(userId)` — sha256 of the user's UUID, top bit
   masked off — so the derivation is deterministic and stable across
   the lifetime of a user record. Both addresses are upserted into
   `deposit_addresses` (unique on `(user_id, network)` and
   `(network, address)`).
   - Ethereum path: `m/44'/60'/0'/0/<idx>` → `ethers.HDNodeWallet`
     produces an EIP-55-checksummed 0x… address.
   - Tron path: `m/44'/195'/0'/0/<idx>` → uncompress secp256k1 pubkey →
     keccak256 → last 20 bytes → prepend `0x41` → Base58Check → T-prefixed
     address. See `services/api/src/lib/hdwallet.ts`.
2. `wallet-watcher` (Go) polls each enabled chain on `WALLET_POLL_MS`
   (default 5 s):
   - **Ethereum** (`internal/ethereum/scanner.go`): `eth_blockNumber`
     for head, then `eth_getLogs` over `[cursor+1, min(head, cursor+maxRange)]`
     filtered to USDT contract + Transfer topic. Decodes `topics[2]` as
     `to`, `data` as uint256 amount (already in micro-USDT — USDT has 6
     decimals). Matches `to` (lower-cased) against `deposit_addresses`.
   - **Tron** (`internal/tron/scanner.go`): TronGrid's
     `/v1/contracts/{usdt}/events?event_name=Transfer` over a
     ms-timestamp window. Address normalizer accepts Base58, hex with
     `0x41` prefix, and 32-byte zero-padded forms. Cursor is stored as
     ms timestamp in `chain_scanner_state.last_block_number` (the
     column is generic — we use it for whatever monotonic position the
     chain exposes).
   Both insert into `deposits` with unique key
   `(network, tx_hash, log_index)` so the same Transfer event is never
   counted twice. Cursor moves forward only — never regresses.
3. Same poll tick runs the deposit processor (`internal/deposits/`):
   for each `seen` or `confirming` deposit, computes
   `confirmations = head - depositBlock + 1`. When ≥ threshold
   (`TRON_CONFIRMATIONS=19`, `ETH_CONFIRMATIONS=12`), one transaction:
   - `UPDATE deposits SET status='credited', credited_at=NOW()`
   - `UPDATE wallets SET balance_micro += amount_micro`
   - `INSERT wallet_ledger (type='deposit', ref_type='deposit',
      ref_id=deposit.id, delta_micro=+amount, tx_hash=…)` — unique
      partial index makes replay a no-op.
4. UI shows the wallet address as text + QR (`qrcode.react`) on `/wallet`.
   `/wallet/deposits` returns the user's deposits with confirmation
   progress (current vs required) for the in-flight ones.

### Wallet withdrawal

The on-chain submission is **not yet automated** — admin manually marks
the tx hash for MVP. Pre-launch a dedicated signer container takes over
(see Phase 7 exit criteria in PHASES.md).

1. User submits `POST /wallet/withdrawals` with `{network, toAddress,
   amountMicro}`. Inside one transaction (with `SELECT FOR UPDATE` on
   wallet): validate destination address shape (regex per chain),
   refuse to withdraw to one of our own deposit addresses, lock the
   amount on `wallets.locked_micro`, insert `withdrawals` row with
   status `requested`.
2. User can `POST /wallet/withdrawals/:id/cancel` while still
   `requested` — releases lock, sets `status='cancelled'`.
3. Admin reviews via `GET /admin/withdrawals` and chooses:
   - `POST /admin/withdrawals/:id/approve` → `status='approved'` (lock
     still held). Optional `feeMicro` is recorded.
   - `POST /admin/withdrawals/:id/reject` → release lock,
     `status='failed'`, audit row.
4. Signer (manual for MVP — admin uses a wallet app + private key)
   broadcasts the tx, then admin posts
   `POST /admin/withdrawals/:id/mark-submitted` with the tx hash →
   `status='submitted'`.
5. After on-chain confirmation, admin posts
   `POST /admin/withdrawals/:id/mark-confirmed`. One transaction:
   release lock, debit `wallets.balance_micro -= (amount + fee)`,
   insert `wallet_ledger (type='withdrawal', ref_type='withdrawal',
   ref_id=withdrawal.id, delta_micro=-(amount+fee), tx_hash=…)`,
   `status='confirmed'`.
6. Failure escape hatch at any approved/submitted state:
   `POST /admin/withdrawals/:id/mark-failed` releases the lock + audit.

Every admin action writes an `admin_audit_log` row inside the same
transaction. Wallet-watcher's chain scanner is **not yet wired** to
auto-flip `submitted → confirmed` based on on-chain inclusion — that's
a Phase 7.5 follow-up; the existing scanner has all the data it needs.

## Non-obvious choices

- **Redis Streams for internal bus, not Kafka.** MVP runs on 4 GB RAM.
  Streams give us at-least-once with consumer groups and are cheap to run.
  When we outgrow the single box, swap the producer in
  `services/feed-ingester/internal/bus/redis.go` and consumer in
  `services/odds-publisher/internal/bus/consumer.go` for Kafka clients —
  no protocol changes upstream/downstream. (The originally-planned shared
  `packages/bus` adapter wasn't needed; both bus call sites are isolated.)
- **Redis pub/sub for hot odds fanout.** Drops on slow subscribers — OK
  because Postgres `published_odds` is the source of truth. Streams would
  backpressure and starve the publisher; we can afford to lose a tick.
- **Go modules per service.** Keeps dependency surfaces small and makes each
  image independently rebuildable. Shared Go helpers duplicate in each
  service's `internal/` rather than sitting in a monorepo module.
- **Idempotency everywhere.** Tickets (`idempotency_key`), settlements
  (5-tuple composite unique), wallet credits (partial unique on `ref_id`),
  deposits (`(network, tx_hash, log_index)`). Given enough crashes,
  retries, and replays, this is what keeps the books balanced.

## Scale path

The design supports lifting and shifting each service to its own box without
code changes — hostnames come from env, inter-service protocols are HTTP/
Redis/Postgres/AMQP (no shared filesystems, no in-process state).

Bottlenecks we'll hit first:

| Symptom | Mitigation |
| --- | --- |
| Postgres CPU pegged on odds updates | Add read replica for `apps/web` SSR + admin; feed-ingester stays on primary. Increase `work_mem` once we're off the 4 GB box. |
| Redis stream backlog | Move `odds-publisher` and `ws-gateway` to separate boxes; increase consumer group parallelism. |
| WS fanout memory | Shard ws-gateway by match-id range; introduce a sticky-session layer in Caddy. |
| Settlement lag on big rollbacks | Increase chunk size from 100 to 500; partition `tickets` by month once table exceeds ~50 M rows. |

Kafka is the end-state bus choice; we'll swap when we leave the single-box
deployment. The `bus` adapter was designed exactly for this day.

## Security boundaries

- Postgres and Redis are bound to `127.0.0.1` inside the Docker network
  only. Caddy never proxies them. `docker-compose.yml` explicitly uses
  `127.0.0.1:5432:5432` style port maps.
- All browser-visible endpoints (`/api/*`, `/ws*`, `/`) go through Caddy with
  HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`.
- Refresh tokens are stored as SHA-256 hashes; the raw token only exists in
  the user's httpOnly + secure + SameSite=Strict cookie.
- JWT access tokens are short-lived (15 min) and signed HS256 by
  `JWT_SECRET`. Refresh rotates the token on every use and revokes the old
  row.
- HD master mnemonic lives in `.env` for MVP. Before public launch this
  moves into a dedicated signer container with a minimal signing API
  (documented as a Phase 7 exit criterion in
  [`PHASES.md`](./PHASES.md)).

## Observability

What's wired today (end of Phase 7):

- All services emit structured JSON logs (`pino` / `zerolog`).
- `/healthz` on every service pings its deps (DB/Redis where applicable)
  and returns `{status, uptimeSeconds, ...}`. Several services also
  surface counters: `odds-publisher` reports `processed`/`errors`,
  `bet-delay` reports `promoted`/`rejected`/`errors`, `settlement`
  reports `settled`/`cancelled`/`rolledBack`/`skipped`/`errors`,
  `wallet-watcher` reports `credited`, `ws-gateway` reports `clients` +
  `matchSubscriptions` + `userSubscriptions`.
- Docker Compose healthchecks poll these; unhealthy containers restart
  per `docker-compose.yml`.

Not wired yet (Phase 8+ candidates):

- Prometheus exporter + Grafana dashboards.
- Wallet reconciliation cron (sum-of-ledger == sum-of-balances).
- Alerting on alive-message gaps from Oddin, settlement lag, scanner
  cursor stuck, RPC error rate.
