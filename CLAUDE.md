# CLAUDE.md — Oddzilla agent doc

This file is loaded into every agent's context. Read it before touching code.
For deeper references see [`docs/`](./docs/).

## TL;DR

Oddzilla is a B2C esports sportsbook MVP. Go services handle the hot path
(Oddin AMQP feed, odds publishing, settlement, bet-delay, wallet watching).
TypeScript handles the REST API, WebSocket gateway, and Next.js frontend.
Postgres 16 + Redis 7 + Caddy, all on one Hetzner box via Docker Compose.

| Question | Answer |
| --- | --- |
| What sportsbook are we building? | B2C, esports-only for MVP: CS2, DOTA2, LOL, Valorant |
| Which markets? | Match Winner (`provider_market_id=1`), Map Winner (`provider_market_id=4`, specifier `map={1,2,3}`) |
| Which feed? | Oddin.gg, **protocol level** (raw AMQP + REST, no SDK) |
| Which chains? | USDT on TRC20 (Tron) and ERC20 (Ethereum), both from day 1 |
| Where does it run? | Hetzner CPX22 at `178.104.174.24` (see [`CONNECT.md`](./CONNECT.md)) |
| How is money stored? | `BIGINT micro_usdt` (1 USDT = 1,000,000 micro) everywhere |
| Auth? | Email + password (argon2id), JWT access (15 min) + refresh cookie (30 d) |
| UI aesthetic? | Dark `#0A0A0A`, high-contrast type, minimalist. **No emojis.** |

Current phase: **Phases 1–8 complete.** News scraper was cancelled during
Phase 8; the service and `news_articles` table were removed (migration
0003). Next: pre-launch exit gates (KYC, signer isolation, backups, wallet
reconciliation, monitoring, runbook). Full roadmap in
[`docs/PHASES.md`](./docs/PHASES.md).

## Architecture map

```
Oddin AMQP+REST ── feed-ingester (Go) ──► Postgres (markets, outcomes, odds_history)
                                       └─► Redis Streams (odds.raw)

Redis Streams ──► odds-publisher (Go) ──► Postgres (published_odds)
                                       └─► Redis pub/sub (odds:match:{id})

Redis pub/sub ──► ws-gateway (TS) ──► browsers (WebSocket, 5 msg/s/client cap)
                                       │
                                       └─ also user:{id} channels for ticket frames

Browser ── Next.js (apps/web) ──► api (TS Fastify) ──► Postgres
                                    │
                                    ├─► POST /bets → ticket → pg_notify('bet_delay')
                                    │      ▼
                                    │   bet-delay (Go) ──► Postgres (promote/reject)
                                    │
                                    └─► POST /wallet/withdrawals → locks stake → admin queue

Oddin AMQP ──► settlement (Go) ──► Postgres (settlements + tickets + wallet_ledger)
                                    └─► Redis pub/sub (user:{id} ticket frames)

Tron + ETH RPC ──► wallet-watcher (Go) ──► Postgres (deposits + wallet_ledger)
                                            (per-chain block scanner + confirmations
                                             tick + atomic credit)
```

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full picture, and
[`docs/ODDIN.md`](./docs/ODDIN.md) for the Oddin protocol details.

## Tech stack (locked)

- **Go 1.23** — `services/{feed-ingester, odds-publisher, settlement, bet-delay, wallet-watcher}`.
  Each service is its own Go module. Shared libs across services:
  `rabbitmq/amqp091-go`, `encoding/xml`, `jackc/pgx/v5` + `pgxpool`,
  `redis/go-redis/v9`, `rs/zerolog`. wallet-watcher uses stdlib `net/http`
  for both Ethereum JSON-RPC and TronGrid REST — no go-ethereum or
  gotron-sdk dependency for read-only scanning. Address derivation is
  done in TS (`services/api/src/lib/hdwallet.ts`); signing for
  withdrawals is intentionally not implemented yet (manual broadcast
  via admin UI for MVP).
- **Node 22 / TypeScript** — `services/{api, ws-gateway, news-scraper}`,
  `apps/web`. Fastify 5, `ws`, `ioredis`, `pino`, `zod`, `jose`,
  `@node-rs/argon2`, `ethers` v6 + `bs58` (HD derivation in API),
  Next.js 15.x, Tailwind v4, `qrcode.react`. shadcn/ui not yet adopted —
  primitives are inline in the dark theme; switch when a real component
  library is needed.
- **Postgres 16** (extensions `pgcrypto`, `citext`, `pg_partman`), **Redis 7**,
  **Caddy 2**. All via Docker Compose.
- **Drizzle ORM** owns the schema. Hand-written SQL migrations in
  `packages/db/migrations/`. Go services read the same tables via raw pgx
  queries (sqlc was planned but not adopted — the query surface is small
  enough that hand-written SQL is clearer than codegen).

## Invariants (non-negotiable)

These rules are load-bearing. Breaking them causes money or data loss.

1. **Money is `BIGINT micro_usdt` (6 decimals, matches on-chain USDT).**
   Column suffix is `_micro`. Never `NUMERIC` for balances/stakes. Never
   `number` in TS (precision loss > 2^53). Use the `MicroUsdt` branded bigint
   from `packages/types/src/money.ts`. JSON serialization: bigints go over
   the wire as decimal strings (`"10000000"` not `10000000`).

2. **Specifier canonicalization.** A market is uniquely keyed by
   `(match_id, provider_market_id, specifiers_hash)`. The hash is sha256 of
   `k1=v1|k2=v2` with keys sorted lexicographically. Three implementations
   that MUST stay byte-identical:
   - TS: [`packages/types/src/specifiers.ts`](./packages/types/src/specifiers.ts)
   - Go (feed-ingester): `services/feed-ingester/internal/oddinxml/specifiers.go`
   - Go (settlement): `services/settlement/internal/oddinxml/specifiers.go`
     (intentionally duplicated per the per-service-Go-module rule)

   All three are tested against the shared
   [`docs/fixtures/specifiers.json`](./docs/fixtures/specifiers.json)
   golden table. If they diverge, settlement silently fails to match
   tickets to settled markets.

3. **Apply-once settlement.** Every Oddin settlement/cancel/rollback message
   inserts into `settlements` keyed by
   `(event_urn, market_id, specifiers_hash, type, payload_hash)` with
   `ON CONFLICT DO NOTHING`. If no row is returned, it's a replay — ack AMQP
   and move on. Implemented in
   `services/settlement/internal/store/store.go` `InsertIfNew()`.

4. **Apply-once wallet credits.** `wallet_ledger` has a unique partial index
   on `(type, ref_type, ref_id) WHERE ref_id IS NOT NULL`. Every credit
   (deposit, payout, refund, manual void, withdrawal debit) supplies a
   stable `ref_id` (ticket UUID, deposit UUID, withdrawal UUID, etc.).
   Replays are no-ops at the row level — three layers of defense
   (settlement insert, wallet_ledger unique index, transactional updates).

5. **Drizzle is the schema source of truth.** Schema changes start in
   `packages/db/src/schema/*.ts` AND a hand-written SQL file in
   `packages/db/migrations/`, with an entry appended to
   `migrations/meta/_journal.json`. Go services use raw pgx queries that
   read those tables directly — no codegen.

6. **No localhost in code.** Every inter-service URL/host comes from env.
   `packages/config/src/env.ts` parses with zod and fails fast on missing
   required vars.

7. **Redis Streams = internal bus. Redis pub/sub = best-effort fanout.**
   Postgres `published_odds` is always the source of truth when a WS client
   reconnects. Pub/sub may drop; streams do not. Two pub/sub channel
   namespaces in use:
   - `odds:match:{matchId}` — one publisher (`odds-publisher`), fan-out
     via `ws-gateway` with 5 msg/s/client token bucket.
   - `user:{userId}` — two publishers (`api` on placement, `bet-delay` /
     `settlement` on lifecycle), fan-out unrate-limited (low volume,
     high-value-to-user ticket frames).

8. **No emojis anywhere — UI text, logs, commit messages, code comments.**
   User requirement.

## Where things live

| Concern | Path |
| --- | --- |
| SQL migrations | [`packages/db/migrations/`](./packages/db/migrations/) (`0000_init` + `0001_odds_history_partitions` + `0002_chain_scanner_state`) |
| Drizzle schema | [`packages/db/src/schema/`](./packages/db/src/schema/) |
| Seed script | [`packages/db/src/seed.ts`](./packages/db/src/seed.ts) |
| Money helpers | [`packages/types/src/money.ts`](./packages/types/src/money.ts) |
| Specifier canonicalization (TS reference) | [`packages/types/src/specifiers.ts`](./packages/types/src/specifiers.ts) |
| Specifier golden fixture | [`docs/fixtures/specifiers.json`](./docs/fixtures/specifiers.json) |
| Shared API/WS/bet/wallet types | [`packages/types/src/`](./packages/types/src/) |
| Auth helpers (argon2id + JOSE JWT) | [`packages/auth/src/`](./packages/auth/src/) |
| Env parsing (zod) | [`packages/config/src/env.ts`](./packages/config/src/env.ts) |
| API plugins (db, redis, auth) | [`services/api/src/plugins/`](./services/api/src/plugins/) |
| API route modules | [`services/api/src/modules/`](./services/api/src/modules/) — `auth`, `users`, `wallet`, `bets`, `catalog`, `admin/{routes,odds-config,tickets,withdrawals}` |
| HD wallet derivation (TS, address-only) | [`services/api/src/lib/hdwallet.ts`](./services/api/src/lib/hdwallet.ts) |
| Oddin XML structs (Go) | `services/feed-ingester/internal/oddinxml/` (also duplicated in `services/settlement/internal/oddinxml/`) |
| Oddin REST client (Go) | `services/feed-ingester/internal/oddinrest/` |
| Auto-mapping resolver (Go) | `services/feed-ingester/internal/automap/` |
| Settlement payout math + tests | `services/settlement/internal/settler/payout.go` |
| Bet-delay evaluator + tests | `services/bet-delay/internal/worker/worker.go` |
| Chain scanners (Go) | `services/wallet-watcher/internal/{ethereum,tron}/`; shared confirmation tick in `internal/deposits/` |
| Frontend live-odds + ticket WS | [`apps/web/src/lib/use-live-odds.ts`](./apps/web/src/lib/use-live-odds.ts), [`use-ticket-stream.ts`](./apps/web/src/lib/use-ticket-stream.ts) |
| Frontend bet slip store + UI | [`apps/web/src/lib/bet-slip.tsx`](./apps/web/src/lib/bet-slip.tsx), [`components/bet-slip.tsx`](./apps/web/src/components/bet-slip.tsx) |
| Server-side fetch (cookie-forwarded) | [`apps/web/src/lib/server-fetch.ts`](./apps/web/src/lib/server-fetch.ts), [`lib/auth.ts`](./apps/web/src/lib/auth.ts) |
| Dark theme tokens | [`apps/web/src/app/globals.css`](./apps/web/src/app/globals.css) |
| Server access | [`CONNECT.md`](./CONNECT.md) |
| Plan file (original brainstorm) | `C:\Users\q1qoo\.claude\plans\initialize-a-full-stack-b2c-peppy-pearl.md` |

## Deep references

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — service interaction, end-to-end flow walkthroughs (odds, bet placement, settlement, deposit, withdrawal), scale path, security boundaries
- [`docs/SCHEMA.md`](./docs/SCHEMA.md) — every table with columns, indexes, rationale, common queries
- [`docs/ODDIN.md`](./docs/ODDIN.md) — AMQP routing keys, XML shapes, REST endpoints, market IDs, recovery protocol
- [`docs/PHASES.md`](./docs/PHASES.md) — phase-by-phase roadmap with delivered detail per phase
- [`docs/OPERATIONS.md`](./docs/OPERATIONS.md) — deploy, env vars, backup, withdrawal admin runbook, incident playbook

## Conventions

- **One domain per file** in `packages/db/src/schema/`. No circular imports
  across packages (enforced by tsconfig project references).
- **Each Go service is its own module** (`services/<name>/go.mod`). Shared Go
  code goes in `services/<name>/internal/`. Do not create a shared Go module
  — duplicate small helpers to keep services independently deployable.
  Examples already duplicated: `oddinxml` (feed-ingester ↔ settlement),
  `amqp` consumer pattern (feed-ingester ↔ settlement).
- **Logs are JSON, structured.** TS uses `pino`, Go uses `zerolog`. Always
  include `service` and `event`/`component` fields.
- **Errors return early, never swallowed.** Go: wrap with
  `fmt.Errorf("context: %w", err)`. TS: throw typed errors from
  `services/api/src/lib/errors.ts`; Fastify maps them to HTTP status codes
  via the `setErrorHandler` in `server.ts`.
- **Tests live next to code.** `*.test.ts` and `*_test.go`. Integration
  tests hit the real Postgres container — never mock the database.
- **Commits:** imperative mood, lowercase, prefix by area
  (`db:`, `api:`, `feed:`, `web:`, `docs:`, `infra:`). No emojis.
- **Graceful idle.** Every service that needs external creds (Oddin AMQP,
  chain RPC) must boot cleanly when those creds are absent — log a warning
  and serve health only. Pattern is well-established in feed-ingester,
  settlement, wallet-watcher.

## Hard limits

- **Don't expose Postgres or Redis publicly.** Compose binds them to
  `127.0.0.1` only; Caddy never fronts them.
- **Don't bypass bet-delay** when a user has `bet_delay_seconds > 0`. The
  admin toggle is the only legitimate way to skip it.
- **Don't return secrets in API responses** — including internal user fields
  like `password_hash`, `refresh_token_hash`, KYC raw documents, and
  `derivation_path` from `deposit_addresses`.
- **Don't run SQL migrations manually on prod.** Use `make migrate`; it's
  transactional and records history in `_migrations`.
- **Don't add a service without adding a healthcheck to compose.** A service
  with no `/healthz` will fail silently.
- **Don't sign withdrawals from the API.** HD derivation in
  `services/api/src/lib/hdwallet.ts` derives **addresses only**. Signing
  is intentionally not implemented in the API — pre-launch, signing moves
  into a dedicated isolated container (see Phase 7 exit criteria in
  [`docs/PHASES.md`](./docs/PHASES.md)).

## Live phase status

What's actually wired up vs scaffolded vs deferred:

| Component | Status | Notes |
| --- | --- | --- |
| DB schema + migrations | Live | 3 migrations: init, odds_history partitions, chain_scanner_state |
| Auth (signup/login/refresh/me + password change) | Live | argon2id + JOSE JWT + refresh-rotation |
| Catalog API + sport/match SSR pages | Live | Empty until feed-ingester runs |
| Bet slip + placement | Live | Singles only; combo math + UI deferred |
| bet-delay worker | Live | LISTEN + 1s sweep + 5% drift tolerance |
| Settlement worker | Live | bet_settlement, bet_cancel (whole-market), rollback_*. Time-window cancel deferred |
| Admin: mapping review | Live | `/admin/mapping` |
| Admin: payback margins | Live | `/admin/margins`, cascade market_type→tournament→sport→global |
| Admin: tickets list + manual void | Live | `/admin/tickets` API only — UI page not built |
| Admin: withdrawals approve flow | Live | `/admin/withdrawals` page with approve/reject/mark-submitted/confirmed/failed |
| Wallet HD address derivation | Live | TS, requires `HD_MASTER_MNEMONIC` |
| Wallet deposit scanners | Live, gated on RPC URLs | Boots idle if `TRON_RPC_URL` / `ETH_RPC_URL` absent |
| Wallet withdrawal on-chain submission | **Manual** | Admin marks-submitted with tx hash from external signer/wallet. Pre-launch needs a dedicated signer container |
| News scraper | Stub only | Schedules cron but doesn't fetch — Phase 8 |
| Admin PnL dashboard | Not started | Phase 8 |
| Combos + cash-out | Not started | Post-MVP |
| Prometheus + Grafana | Not started | Phase 4 noted; defer until traffic justifies |

## Local secrets that exist (DO NOT commit)

`D:\AI\Oddzilla\.env` (gitignored) currently contains:
- `ODDIN_TOKEN=<redacted>` (Sasha's Oddin integration token; in `.env`, never in docs)
- `ODDIN_CUSTOMER_ID=` **empty — needs to be fetched** via
  `curl -H "x-access-token: $ODDIN_TOKEN" https://api-mq.integration.oddin.gg/users/whoami`
- `JWT_SECRET` + `REFRESH_COOKIE_SECRET` — generated 48-byte secrets
- `POSTGRES_PASSWORD` — generated 64-char hex
- `HD_MASTER_MNEMONIC=` **empty** — withdrawal/deposit features inert
  until set. Generate any BIP39 phrase (`ethers.Mnemonic.entropyToPhrase`
  / `bip39 generate` / a hardware wallet export).
- `TRON_RPC_URL` defaults to `https://api.trongrid.io`
- `ETH_RPC_URL=` **empty** — ERC20 scanner inert until provided

`.gitignore` already excludes `.env`; the repo is not git-initialized as of
the last session, so there's zero exposure risk on disk.

## Verification commands

When in doubt that everything is wired up, run from repo root:

```bash
pnpm -r typecheck    # all 10 TS workspaces
for svc in feed-ingester odds-publisher settlement bet-delay wallet-watcher; do
  (cd services/$svc && go vet ./... && go test ./...)
done
```

Both should be silent / 100% green. Last known good state: end of Phase 7.

## Handoff notes for the next session

If you're a fresh agent picking this up:

1. **Read this file first** (you're here). Then skim
   [`docs/PHASES.md`](./docs/PHASES.md) for what's done and what's next.
2. **Phase 8 is up next** — admin dashboard PnL queries (joining
   `wallet_ledger → tickets → ticket_selections → markets → matches →
   tournaments → categories → sports`) and the news scraper (HLTV RSS
   + Liquipedia with attribution). See the Phase 8 entry in PHASES.md.
3. **Pre-launch exit gates** are listed at the end of PHASES.md — KYC,
   licensing, signer isolation, backups, monitoring. None are blockers
   for Phase 8 work but they ARE blockers for accepting real user
   traffic.
4. **Before touching anything money-related**, re-read invariants 3 + 4
   above. The two-layer apply-once (settlements unique 5-tuple + ledger
   unique partial index) is what keeps the books consistent under crash,
   replay, and race conditions.
5. **Don't trust comments that mention "Phase X is next" inside source
   files** — phase progress moved fast. CLAUDE.md's "Live phase status"
   table is the truth.
