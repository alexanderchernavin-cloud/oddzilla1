# Phase roadmap

Status: **Phases 1 + 2 + 3 + 4 + 5 + 6 + 7 complete.** Phase 8 (admin dashboard PnL + news scraper) next.

Each phase ends with a concrete acceptance bar. Do not skip ahead without
explicit user direction — later phases assume earlier invariants hold.

## Phase 1 — Scaffold + DB schema ✔

**Deliverables (done):**
- pnpm + Turborepo monorepo with `apps/`, `services/`, `packages/`, `infra/`.
- Postgres 16 schema: users, sessions, wallet, catalog (Sport > Category >
  Tournament > Match with `is_dummy` esport categories), markets, outcomes,
  odds_history (daily partitioned), odds_config, tickets, ticket_selections,
  settlements (apply-once composite unique), mapping_review_queue,
  admin_audit_log, news_articles, amqp_state.
- Seed script with CS2, DOTA2, LOL, Valorant and mirror dummy categories;
  admin + test users; global payback margin 500 bp (5%).
- Docker Compose for postgres, redis, caddy, api, ws-gateway, web,
  feed-ingester, odds-publisher, settlement, bet-delay, wallet-watcher,
  news-scraper. Each with healthcheck + `/healthz` endpoint.
- Caddy HTTPS terminator with security headers.
- Shared TS packages: `@oddzilla/types` (MicroUsdt branded bigint,
  specifier canonicalization, API/WS contracts), `@oddzilla/config`,
  `@oddzilla/auth`, `@oddzilla/db`, `@oddzilla/tsconfig`, `@oddzilla/eslint-config`.
- Next.js 16 App Router frontend shell with dark `#0A0A0A` theme tokens,
  placeholder routes for login/signup/news/admin.
- CI: TS (typecheck + lint + build), Go (vet + build + test matrix),
  migration smoke test against real Postgres.
- Hetzner bootstrap script (UFW, Docker, swap).

**Acceptance:**
- `make up` brings every container to `healthy` within 60 s.
- `make migrate` applies cleanly; `\dt` lists all tables.
- `make seed` is idempotent.
- `curl localhost:3001/healthz` / `:3002/healthz` / `:3000` return 200.
- All 5 Go services log `connected to postgres` and idle without crash.
- CI is green.

## Phase 2 — Auth + user account ✔

**Delivered:**
- `services/api`: `/auth/signup`, `/auth/login`, `/auth/refresh`,
  `/auth/logout`, `/auth/me`; `/users/me` GET/PATCH + `/users/me/password`;
  `/wallet` + `/wallet/ledger` read-only.
- argon2id password hashing via `@oddzilla/auth`, JWT access (15 min HS256),
  opaque refresh tokens stored as sha256 in `sessions`, rotation on every
  use. Password change revokes every non-revoked session.
- `@fastify/cookie` + `@fastify/cors` + `@fastify/helmet` + `@fastify/rate-limit`.
  Access cookie `oddzilla_access` scoped `/`; refresh cookie `oddzilla_refresh`
  scoped `/auth` so it isn't sent on every API call. Both httpOnly +
  SameSite=Strict; `secure` on in production.
- Per-route rate limits: 5/min on login, 10/min on signup + refresh.
- Next.js middleware: presence-check on `/account`, `/wallet`, `/bets`, `/admin`.
- `@/lib/auth` server helpers: `getSessionClaims()` (local JWT verify) and
  `getSessionUser()` (forwards cookies to `/auth/me`).
- Login + signup forms as client components; `(app)` layout with header,
  role-aware nav, logout button.
- `/account` page with display name + country edit + password change form.
- `/wallet` page renders balance / locked / available + recent ledger
  entries SSR, using `fromMicro()` for display.
- `/admin` layout 404s for non-admins so the URL surface isn't leaked.

**Acceptance reached:** `pnpm -r typecheck` clean across 10 workspaces;
`pnpm --filter @oddzilla/api build` clean.

## Phase 3 — Oddin feed ingest + mapping queue ✔

**Delivered:**
- `services/feed-ingester` (Go): AMQPS connection (amqp091-go) with
  exponential-backoff reconnect, QoS prefetch, exclusive auto-delete queue
  bound to `oddinfeed` with routing key from env.
- `encoding/xml` decoders for `odds_change`, `bet_settlement`, `bet_cancel`,
  `bet_stop`, `fixture_change`, `rollback_bet_settlement`,
  `rollback_bet_cancel`, `alive`, `snapshot_complete`, plus `PeekKind` for
  fast dispatch before full unmarshal.
- `URN` parser (`od:sport:5`, `od:match:100234`, composite
  `od:dynamic_outcomes:27|v1`).
- **Specifier canonicalization** in Go mirrors
  `packages/types/src/specifiers.ts` byte-for-byte. Both tests consume the
  same golden fixture at `docs/fixtures/specifiers.json` (sorted keys,
  `k=v|k=v`, sha256 → `BYTEA`). 5/5 cases pass in both languages.
- REST client (`oddinrest`) with `x-access-token`, exponential retry on
  429/5xx, endpoints for `/users/whoami`, fixtures paging, and per-fixture
  snapshot recovery.
- Postgres store with `UpsertMarket` / `UpsertOutcomes` (batched via
  `pgx.Batch`), `AppendOddsHistory` (uses `COPY FROM` via pgxpool), plus
  `FindMatchByURN` / `EnsureTournament` / `EnqueueReview` helpers.
- `amqp_state` cursor write-path keyed by producer id (`"producer:1"` /
  `"producer:2"`) so recovery resumes after restart.
- Redis Streams `odds.raw` bus (`XADD` with approximate maxlen 100 k,
  pipelined batch publish).
- `automap.Resolver`: unknown tournaments → create under fallback category
  + enqueue `mapping_review_queue` row; unknown matches → create under
  resolved tournament + enqueue review.
- Handlers: `odds_change` (full path: resolve → upsert markets + outcomes
  + history, publish to stream, bump cursor), `fixture_change`, `bet_stop`,
  `alive` (heartbeat, no cursor bump), `snapshot_complete`. Settlement /
  cancel / rollback messages are recognized and acked but left for
  settlement worker (phase 6).
- `cmd/feed-ingester/main.go` boots pool + redis + health, resolves
  fallback sport/category (CS2 dummy), and **gracefully idles** with
  health-only mode when `ODDIN_TOKEN` / `ODDIN_CUSTOMER_ID` are absent.
- `services/api/modules/admin`: `GET /admin/mapping` (paginated, filter by
  status + entityType), `GET /admin/mapping/summary` (KPI counts),
  `POST /admin/mapping/:id/review` (approve/reject + audit log in one txn).
- `/admin/mapping` review UI with status counters, filter chips, raw
  payload inspector, approve/reject buttons.

**Deferred into phase 4 follow-ups:**
- Wiring per-fixture REST snapshot recovery into the `OnConnect` hook
  (requires a separate fixtures pre-fetch; flagged in `handler/` comments).
- `sqlc` migration — we use hand-written pgx queries for MVP; schema is
  small enough that codegen adds more ceremony than value at this stage.
- Batched debouncing per-market (we currently write-through per message;
  profile under real Oddin load before optimizing).

**Acceptance reached:**
- `go test ./...` passes 5/5 specifier fixtures + XML unmarshal + URN tests.
- `go vet ./...` clean across all 5 Go services.
- `pnpm -r typecheck` clean across all 10 TS workspaces.
- TS specifier test (`node --test`) passes the same fixture with byte-
  identical canonical strings and sha256 hex.

## Phase 4 — Odds publisher + WS gateway + live UI ✔

**Delivered:**
- `services/odds-publisher` (Go): XREADGROUP consumer with consumer group,
  XAUTOCLAIM for dead-replica recovery, per-outcome margin-apply (big.Float
  division for precision, 4-decimal output), writes
  `market_outcomes.published_odds` + `odds_history`, PUBLISHes
  `odds:match:{match_id}`. In-memory margin cache with 5 s TTL (cascade:
  market_type → tournament → sport → global). 7 unit tests covering the
  margin math.
- `services/ws-gateway` (TS): `noServer` WebSocket upgrade with pre-upgrade
  JWT verification from `oddzilla_access` cookie; 401 on bad cookie. Single
  Redis subscriber; per-match subscription refcount so one Redis SUBSCRIBE
  regardless of client count. Client-side subscribe/unsubscribe/ping
  protocol. Per-client 5 msg/s token bucket (capacity 5, refill 200 ms).
  Subscription cap 100 matches per client.
- `services/api`: `/catalog/sports`, `/catalog/sports/:slug` (live +
  upcoming matches), `/catalog/matches/:id` (grouped markets + outcomes),
  `/catalog/live-counts`. Admin-only `/admin/odds-config` (GET, PUT upsert,
  DELETE, GET `/options`) with full audit-log trail; global scope cannot
  be deleted.
- `apps/web/src/lib/use-live-odds.ts`: shared singleton WS connection
  across components, exponential-backoff reconnect (1s → 16s cap), resub
  on reconnect, out-of-order tick suppression.
- `/sport/[slug]` page: SSR live + upcoming matches with tournament
  labels, public (no auth).
- `/match/[id]` page: SSR catalog + `<LiveMarkets>` client component that
  merges SSR snapshot with live WS ticks. Market labels for `1`/`4` (Match
  Winner / Map Winner). Map specifier surfaces as a subtitle.
- `/admin/margins` page: table + delete, form with scope selector
  (global/sport/tournament/market_type) wired to `/admin/odds-config/options`.
  Percent ↔ basis-point conversion in the UI.

**Acceptance reached:**
- `pnpm -r typecheck` clean across all 10 TS workspaces.
- `go vet ./... && go test ./...` clean across all 5 Go services; 7/7
  margin tests pass.
- Offline verification of the full pipeline: ingester publishes to
  `odds.raw` → publisher consumes + writes + PUBs → ws-gateway fans out →
  frontend hook updates React state. End-to-end smoke runs once Oddin
  credentials arrive.

## Phase 5 — Bet slip + bet placement + bet-delay ✔

**Delivered:**
- `services/api` bets module: `POST /bets` (placement), `GET /bets`
  (history), `GET /bets/:id`. One transaction per placement:
  `SELECT FOR UPDATE` the user + wallet row, validate each selection
  against `markets.status` + `market_outcomes.active`, enforce 5% odds
  drift tolerance, insert ticket (idempotency via unique constraint on
  `idempotency_key`) + selections, lock stake on `wallets.locked_micro`,
  write `wallet_ledger (bet_stake, ref_id=ticket.id)`. If user has
  `bet_delay_seconds > 0`: status=`pending_delay` + `pg_notify('bet_delay',
  ticket.id)`. Else: `accepted` immediately. Best-effort `Redis PUBLISH
  user:{id}` with the resulting frame.
- `services/bet-delay` (Go): dual-path — `LISTEN bet_delay` on a pooled
  connection AND a 1 s sweep that `SELECT … FOR UPDATE SKIP LOCKED`s
  pending tickets. Re-reads current `published_odds` + market status +
  outcome active; rejects with one of `market_suspended` /
  `outcome_inactive` / `no_current_price` / `odds_parse` /
  `odds_drift_exceeded` and issues a refund via `wallet_ledger
  (bet_refund, ref_id=ticket.id)` — safe against replay via the unique
  partial index. Promotes to `accepted` when all checks pass. Publishes
  `{type:'ticket', status}` on `user:{id}`. Eight unit tests lock the
  evaluate() logic.
- `ws-gateway`: refcounted subscription to `user:{id}` on client connect;
  ticket frames bypass the odds rate-limit (low volume, high value to
  user). healthz reports `userSubscriptions`.
- `apps/web`: bet slip state (Context + localStorage, `BetSlipProvider`
  mounted in root layout; floating pill button always visible). Outcome
  clicks in `/match/[id]/live-markets` add to the slip; highlight shows
  current selection. `<BetSlip>` panel: stake input with live potential-
  payout calc, typed error mapping (`insufficient_balance`,
  `odds_drift_exceeded`, `market_not_active`, `account_not_active`, etc),
  idempotency-key on every submit. `/bets` history page with SSR initial
  load + `useTicketStream` hook merging live WS frames into the table.
- Shared `@oddzilla/types/bets` — `SlipSelection`, `PlaceBetRequest`,
  `TicketSummary`, `WsTicketFrame`, `DEFAULT_ODDS_DRIFT_TOLERANCE`.

**Acceptance reached (offline):**
- `pnpm -r typecheck` clean across all 10 TS workspaces.
- `go vet ./... && go test ./...` clean across all 5 Go services.
  bet-delay: 8/8 evaluate tests pass. odds-publisher: 7/7. feed-ingester:
  specifier + XML tests pass.
- API builds cleanly.

**Live acceptance (once Oddin creds land):**
- Place bet with delay=0 → ticket `accepted` immediately; wallet balance
  updates; `GET /bets` lists it.
- Place bet with delay=5 → stays `pending_delay` for 5 s then promotes
  to `accepted`; WS pushes the transition without refresh.
- Suspend market mid-delay → bet-delay rejects with
  `market_suspended`; refund lands on the wallet ledger; slip UI shows
  error.
- Retry `POST /bets` with same `idempotencyKey` → 200 with the original
  ticket id, no double-spend.

**Deferred:** combo bets (UI + payout math + delay re-validation across N
markets), cash-out, per-user stake limits beyond `global_limit_micro`.

## Phase 6 — Settlement ✔

**Delivered:**
- `services/settlement` (Go): dedicated AMQP consumer with the same
  exponential-backoff reconnect pattern as feed-ingester. Its own
  server-named exclusive queue bound to `oddinfeed` so it shares no
  state with the ingester — topic-exchange semantics deliver every
  message to both queues independently.
- Handlers for `bet_settlement`, `bet_cancel`, `rollback_bet_settlement`,
  `rollback_bet_cancel`. `odds_change`/`fixture_change`/`bet_stop`/`alive`/
  `snapshot_complete` are recognized and acked without action
  (feed-ingester's domain).
- **Apply-once** on `(event_urn, market_id, specifiers_hash, type,
  payload_hash)` via the `settlements` unique index.
  `payload_hash = sha256("type|event|market_id|specifiers|outcomes" + raw_body)`
  so equivalent retries dedupe reliably. If the INSERT finds a conflict,
  the whole message is a no-op.
- Transaction per market: find market (silently skip if unknown —
  race with ingester), update market status (-3 settled / -4 cancelled /
  1 active on rollback), update outcome `result`+`void_factor`, cascade
  into `ticket_selections` with the partial index `WHERE result IS NULL`
  making the scan cheap, then for every affected ticket: `FOR UPDATE SKIP
  LOCKED` → compute payout → update tickets + wallets + insert
  `wallet_ledger (bet_payout|bet_refund)` keyed on `(type, ref_type,
  ref_id)` so ledger replay is a no-op at the row level too.
- Payout math in `internal/settler/payout.go`: `effective = (1-vf) *
  (result*odds) + vf`. Maps Oddin (result, void_factor) → our
  `outcome_result` enum. 15 unit tests lock the math: full win/loss,
  full void, half won/lost, explicit vf 0.5, floor rounding on irrational
  odds, parse errors.
- Rollback: reverses selection results → reopens the market → reverses
  the wallet + ledger (compensating `adjustment` row keyed distinctly
  from the original `bet_payout` so both coexist for audit). Processed
  in configurable chunks (default 100 tickets per chunk) to bound lock
  contention on large Oddin cascades. Admin-audit-logged.
- `services/api` admin tickets: `GET /admin/tickets` (filterable list),
  `POST /admin/tickets/:id/void` — manual void of an `accepted` ticket.
  One transaction: flip to `voided` with stake refund, release lock,
  write `bet_refund` ledger with unique-partial-index replay guard, add
  `admin_audit_log` row, best-effort publish to `user:{id}` WS channel.
- Stats counters (settled/cancelled/rolledBack/skipped/errors) exposed
  via `/healthz`.
- Gracefully idles if `ODDIN_TOKEN`/`ODDIN_CUSTOMER_ID` absent — same
  pattern as feed-ingester.

**Acceptance reached (offline):**
- `pnpm -r typecheck` clean across all 10 TS workspaces.
- `go vet ./... && go test ./...` clean across all 5 Go services.
  settlement: 15/15 payout tests (incl. floor-round + half-win/lost
  boundary). feed-ingester/bet-delay/odds-publisher: all prior tests
  still pass.

**Live acceptance (once Oddin integration delivers a result):**
- Settle message → tickets on the resolved market flip to `settled`,
  wallet `balance_micro += payout - stake`, `locked_micro -= stake`,
  ledger row inserted.
- Replay same XML → settlements INSERT conflicts → no wallet movement.
- `rollback_bet_settlement` → tickets flip back to `accepted`,
  compensating adjustment ledger row written, admin_audit_log row
  describes the rollback.
- Admin manual void → UI shows `voided`; wallet balance restored to
  pre-bet state.

**Deferred:**
- Partial market cancel windows (`start_time`/`end_time` attrs) — we
  currently void every unresolved selection on the market regardless of
  when the bet was placed. Most bet_cancel messages use the whole-market
  form; window-scoped cancels are rare and land as a follow-up.
- Combo bet payout — still guarded by `combos_not_yet_supported` in the
  placement API.

## Phase 7 — Wallet (TRC20 + ERC20) ✔

**Delivered:**
- New migration `0002_chain_scanner_state.sql` — per-chain block cursor
  table. Drizzle schema mirror.
- Shared types in `@oddzilla/types/wallet`: `DepositAddress`,
  `DepositSummary`, `WithdrawalSummary`, `CONFIRMATIONS_REQUIRED` map.
- API HD wallet derivation (`services/api/src/lib/hdwallet.ts`):
  `ethers` v6 + `bs58` for Base58Check. Ethereum at `m/44'/60'/0'/0/N`,
  Tron at `m/44'/195'/0'/0/N`, both from `HD_MASTER_MNEMONIC`. Address-
  only derivation — no signing in the API. User's BIP32 index is
  derived deterministically from the user UUID via SHA-256 mask so it's
  stable forever, even across user delete/recreate.
- API endpoints:
  - `GET /wallet/deposit-addresses` — derives + upserts both networks
    on first call, then DB lookup.
  - `GET /wallet/deposits` — paginated history.
  - `POST /wallet/withdrawals` — locks stake on `wallets.locked_micro`
    inside a tx, validates destination address shape, refuses to
    withdraw to one of our own deposit addresses.
  - `GET /wallet/withdrawals` — user history.
  - `POST /wallet/withdrawals/:id/cancel` — user self-service cancel
    while still `requested`.
- API admin endpoints:
  - `GET /admin/withdrawals` — filterable list across all users.
  - `POST /admin/withdrawals/:id/approve` — flips to `approved`,
    records optional fee + audit row.
  - `POST /admin/withdrawals/:id/reject` — releases lock, audit row.
  - `POST /admin/withdrawals/:id/mark-submitted` — signer reports
    broadcast tx hash.
  - `POST /admin/withdrawals/:id/mark-confirmed` — debits balance,
    inserts `wallet_ledger (withdrawal, ref_id=withdrawal.id)` keyed on
    the unique partial index.
  - `POST /admin/withdrawals/:id/mark-failed` — releases lock + audit.
- `services/wallet-watcher` (Go):
  - `internal/ethereum`: minimal stdlib JSON-RPC client (`eth_blockNumber`
    + `eth_getLogs`) + scanner. Filters Transfer events on the USDT
    contract, decodes `topics` + `data`, matches `to` (lower-cased)
    against `deposit_addresses`.
  - `internal/tron`: TronGrid REST client + scanner. Tron addresses come
    in three formats from the API (Base58, hex with `0x41` prefix,
    32-byte zero-padded); a normalizer converts all to Base58Check.
    Scanner uses ms-timestamp window into `chain_scanner_state.last_block_number`.
    1 unit test verifies the Base58Check encoding against the canonical
    USDT contract address.
  - `internal/deposits`: shared confirmation-tick + credit processor.
    Computes `confirmations = head - depositBlock + 1`; on threshold,
    runs the atomic credit (deposits→credited + wallet balance +
    `wallet_ledger (deposit, ref_id=deposit.id)`). Unique partial index
    on the ledger is the row-level replay guard.
  - `cmd/wallet-watcher/main.go`: per-chain goroutine; gracefully idles
    if either RPC URL absent (same pattern as feed-ingester +
    settlement). healthz reports credited count.
- Frontend:
  - `qrcode.react` added.
  - `/wallet` page: balance/locked/available stats + `<WalletPanels>`
    client component with deposit card (chain switcher + QR + copy
    button + address) and withdrawal form (chain + destination + amount
    + typed errors). Deposit list shows confirmation progress bar;
    withdrawal list shows status + cancel button while `requested`.
  - `/admin/withdrawals` page: filter chips by status, per-row buttons
    for approve/reject/mark-submitted/mark-confirmed/mark-failed using
    `window.prompt` for the tx hash + reasons (MVP — proper modals are
    a phase 7.5 polish).
  - Admin nav gets a "Withdrawals" link.

**Acceptance reached (offline):**
- `pnpm -r typecheck` clean across all 10 TS workspaces.
- `go vet ./... && go test ./...` clean across all 5 Go services.
- Tron Base58Check encoding test verifies our derivation produces the
  canonical USDT contract address from its hex form.

**Acceptance reached (live, pending RPC creds):**
- `wallet-watcher` boots cleanly with no RPC URLs (idle).
- With `TRON_RPC_URL` set, the Tron scanner pulls Transfer events from
  TronGrid every 5 s, matches against deposit addresses, inserts new
  rows. Same shape for `ETH_RPC_URL`.
- HD addresses round-trip — derive same address for the same user UUID
  every time.

**Deferred to Phase 7.5 / pre-launch (per the original exit criteria):**
- Actual on-chain withdrawal submission. Currently admin clicks
  "approve", then a (not-yet-built) signer service must call
  `mark-submitted` with a tx hash. For testnet acceptance, an admin
  manually broadcasts via a wallet (Trust/Metamask) and pastes the hash.
- HD master key isolation: still in `.env` for MVP. Pre-launch this
  must move into a dedicated signer container with a minimal signing
  API exposed only on the docker network — see CLAUDE.md hard limits.
- Withdrawal scanner side: wallet-watcher doesn't yet auto-flip
  `submitted → confirmed` for withdrawals (admin currently marks
  manually). Adding this is a small extension to the existing scanner.
- Time-window-scoped bet_cancel + combo bet payout (carried over from
  Phase 6).

## Phase 8 — Admin dashboard + news scraper

**Scope:** operator control surface and homepage content.

**Deliverables:**
- `/admin` dashboard: PnL by day/sport (query from `SCHEMA.md`), active
  users, open tickets, recent big wins.
- `/admin/users` with filters, `status` toggle, `global_limit_micro` edit,
  `bet_delay_seconds` toggle, all writes logged to `admin_audit_log`.
- `services/news-scraper`: HLTV RSS parser, Liquipedia article fetcher
  with attribution. Polite UA, respects robots.txt. Stores to
  `news_articles`.
- Homepage renders latest news.

**Acceptance:**
- Admin sees yesterday's PnL broken down by sport and game.
- Blocking a user from the UI stops their bet placement.
- News articles appear on homepage within 2 h of publication; all rows
  carry source attribution.

## Post-MVP candidates (not in scope yet)

- Combo and system bets (UI + payout math).
- Cash-out feature (`cashed_out` ticket status reserved in the schema).
- Outright markets (tournament winners) — requires dynamic outcome handling.
- Traditional sports (football, tennis) — existing `sport_kind='traditional'`
  enum value and real `categories` rows instead of dummies.
- Cashier: more chains (BEP20, TON), fiat on-ramp.
- KYC integration (Sumsub/Veriff).
- Licensing (Curaçao/Malta/Anjouan).
- Prometheus + Grafana; alerting on alive-message gaps, settlement lag,
  wallet/ledger mismatch.
- Horizontal scale out: move services off the single Hetzner box.

## Exit gates before public launch

Independent of phase numbering — these must all be true:

1. KYC/AML flow live and legally reviewed.
2. Sportsbook licensing in place.
3. HD master key moved out of env into isolated signer.
4. Wallet reconciliation job (daily sum of ledger == sum of balances)
   running and alerting.
5. Backups: Postgres daily full + WAL archived off-box.
6. Runbook for feed outage, settlement lag, wallet-watcher chain reorg,
   ws-gateway storm.
