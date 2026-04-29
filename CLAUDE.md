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
| What sportsbook are we building? | B2C, esports-only. Every Oddin esport is surfaced; CS2, DOTA2, LOL, Valorant pinned at the top of the sidebar; `efootballbots` + `ebasketballbots` excluded (backend blocklist + DB inactive). |
| Which markets? | All Oddin markets — the `provider_market_id` whitelist was dropped at both feed-ingester and `/catalog/matches/:id`. Known labels for match-winner (`1`) and map-winner (`4`); others render as "Market #N". |
| Which feed? | Oddin.gg, **protocol level** (raw AMQP + REST, no SDK) |
| Which chains? | USDT on TRC20 (Tron) and ERC20 (Ethereum), both from day 1 |
| Where does it run? | Hetzner CPX22 at `178.104.174.24` (see [`CONNECT.md`](./CONNECT.md)). Public URLs: **`s.oddzilla.cc`** (storefront) + **`sadmin.oddzilla.cc`** (admin; `/` redirects to `/admin`). Let's Encrypt via Caddy. |
| How is money stored? | `BIGINT micro_usdt` (1 USDT = 1,000,000 micro) everywhere |
| Auth? | Email + password (argon2id), JWT access (15 min) + refresh cookie (30 d). `Domain=.oddzilla.cc` so session works on both subdomains. |
| UI aesthetic? | Premium / quiet editorial: Instrument Serif display + Geist UI + Geist Mono for odds. Dark theme default (`#0b0b0c`), light via `data-theme="light"`. Ported from the Claude Design handoff bundle. **No emojis.** |

Current phase: **Phases 1–8 complete + security hardening + catalog cleanup
+ frontend redesign.** News scraper was cancelled during Phase 8 (migration
0003). As of 2026-04-18 the site is live at `s.oddzilla.cc` with the new
design, market whitelist active, and `payback_margin_bp=0` globally (Oddin
already sends margined odds — see [`docs/OPERATIONS.md`](./docs/OPERATIONS.md)
before re-enabling). Next: pre-launch exit gates (KYC, signer isolation,
wallet reconciliation, off-server backup rsync, monitoring, runbook).
Full roadmap in [`docs/PHASES.md`](./docs/PHASES.md).

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
- **Node 22 / TypeScript** — `services/{api, ws-gateway}`, `apps/web`.
  Fastify 5, `ws`, `ioredis`, `pino`, `zod`, `jose`, `@node-rs/argon2`,
  `ethers` v6 + `bs58` (HD derivation in API), Next.js 15.x, Tailwind v4,
  `qrcode.react`. shadcn/ui not yet adopted — primitives are inline in the
  dark theme; switch when a real component library is needed. The api
  container starts via `tsx src/server.ts` rather than compiled JS because
  the `@oddzilla/db` workspace ships source TypeScript; switch to a build
  step when packages get heavier.
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
| SQL migrations | [`packages/db/migrations/`](./packages/db/migrations/) — `0000_init`, `0001_odds_history_partitions`, `0002_chain_scanner_state`, `0003_drop_news_articles`, `0004_unclassified_sport`, `0005_merge_duplicate_sports`, `0006_market_descriptions`, `0007_purge_non_mvp_sports` (superseded by 0012), `0008_competitors` (teams as first-class per-sport entities), `0010_odds_config_global_unique`, `0011_feed_messages` (raw AMQP message log keyed to match for the `/admin/logs` panel; retention = `match.scheduled_at + 24h`, hard 48h cap on unmapped URNs), `0012_reactivate_non_bot_sports` (re-enables every non-bot sport after the product opened past the 4-MVP scope) |
| Drizzle schema | [`packages/db/src/schema/`](./packages/db/src/schema/) |
| Seed script | [`packages/db/src/seed.ts`](./packages/db/src/seed.ts) — seed sport URNs are `od:sport:{3,2,1,13}` matching real Oddin feed (do NOT revert to synthetic `od:sport:cs2` etc. — it breaks auto-mapping) |
| Money helpers | [`packages/types/src/money.ts`](./packages/types/src/money.ts) |
| Specifier canonicalization (TS reference) | [`packages/types/src/specifiers.ts`](./packages/types/src/specifiers.ts) |
| Specifier golden fixture | [`docs/fixtures/specifiers.json`](./docs/fixtures/specifiers.json) |
| Shared API/WS/bet/wallet types | [`packages/types/src/`](./packages/types/src/) |
| Auth helpers (argon2id + JOSE JWT) | [`packages/auth/src/`](./packages/auth/src/) |
| Env parsing (zod) | [`packages/config/src/env.ts`](./packages/config/src/env.ts) |
| API plugins (db, redis, auth) | [`services/api/src/plugins/`](./services/api/src/plugins/) |
| API route modules | [`services/api/src/modules/`](./services/api/src/modules/) — `auth`, `users`, `wallet`, `bets`, `catalog`, `admin/{routes,odds-config,tickets,withdrawals,dashboard,users,audit,feed,logs}`. `users` accepts `?roles=admin,support` (CSV) for the Admin user-management view. `logs` powers the sport→tournament→match browser with per-match odds-history + raw feed-message endpoints. |
| HD wallet derivation (TS, address-only) | [`services/api/src/lib/hdwallet.ts`](./services/api/src/lib/hdwallet.ts) |
| Oddin XML structs (Go) | `services/feed-ingester/internal/oddinxml/` (msg + fixture decoders; also duplicated in `services/settlement/internal/oddinxml/`) |
| Oddin REST client (Go) | `services/feed-ingester/internal/oddinrest/` — `WhoAmI`, `Fixtures`, `SportEventFixture`, `Sports`, `SnapshotRecovery`, `InitiateRecovery` |
| Auto-mapping resolver (Go) | `services/feed-ingester/internal/automap/` — REST-driven sport/category/tournament/match auto-creation; `RefreshFromFixture` for fixture_change re-fetch |
| Recovery + alive-gap + handover sweeper | `services/feed-ingester/internal/handler/handler.go` (`TriggerRecovery`, `AliveState`, `mapFixtureStatus`); `services/feed-ingester/cmd/feed-ingester/main.go` (`runHandoverSweeper`) |
| Settlement payout math + tests | `services/settlement/internal/settler/payout.go` |
| Settlement workflows (settle + cancel + rollbacks + cancel-after-settle + per-generation ledger refs) | `services/settlement/internal/settler/settler.go`; `services/settlement/internal/store/store.go` (`nextPayoutRefID`, `LatestUnreversedPayoutRefID`) |
| Bet-delay evaluator + tests | `services/bet-delay/internal/worker/worker.go` |
| Chain scanners (Go) | `services/wallet-watcher/internal/{ethereum,tron}/`; shared confirmation tick in `internal/deposits/` |
| Frontend live-odds + ticket WS | [`apps/web/src/lib/use-live-odds.ts`](./apps/web/src/lib/use-live-odds.ts), [`use-ticket-stream.ts`](./apps/web/src/lib/use-ticket-stream.ts) |
| Frontend bet slip store | [`apps/web/src/lib/bet-slip.tsx`](./apps/web/src/lib/bet-slip.tsx) |
| Bet slip right-rail UI | [`apps/web/src/components/shell/bet-slip-rail.tsx`](./apps/web/src/components/shell/bet-slip-rail.tsx) |
| Shell components | [`apps/web/src/components/shell/`](./apps/web/src/components/shell/) — `top-bar.tsx`, `sidebar.tsx`, `bet-slip-rail.tsx`, `theme-toggle.tsx` |
| UI primitives | [`apps/web/src/components/ui/`](./apps/web/src/components/ui/) — `primitives.tsx` (Button, Pill, LiveDot, Tabs, OddButton, TeamMark, Divider), `icons.tsx`, `monogram.tsx`, `sport-glyph.tsx` |
| Match-row component | [`apps/web/src/components/match/match-row.tsx`](./apps/web/src/components/match/match-row.tsx) |
| Server-side fetch (cookie-forwarded) | [`apps/web/src/lib/server-fetch.ts`](./apps/web/src/lib/server-fetch.ts), [`lib/auth.ts`](./apps/web/src/lib/auth.ts) |
| Browser API/WS clients | [`apps/web/src/lib/api-client.ts`](./apps/web/src/lib/api-client.ts) (empty `NEXT_PUBLIC_API_URL` → `/api` prefix; in dev set `.env.local`), [`ws-client.ts`](./apps/web/src/lib/ws-client.ts) (empty `NEXT_PUBLIC_WS_URL` → `wss://<host>/ws`) |
| Design tokens + Tailwind @theme bridge | [`apps/web/src/app/globals.css`](./apps/web/src/app/globals.css) |
| Route groups | `apps/web/src/app/{(main),(auth)}/` — `(main)` shares the shell, `(auth)` = login/signup, `admin/*` outside both |
| Admin pages (web) | [`apps/web/src/app/admin/`](./apps/web/src/app/admin/) — `page.tsx` (PnL dashboard), `users` (Bettor user management — pinned to `role=user`), `users/[id]` (edit; breadcrumb routes back to Bettors or Admins per role), `admins` (Admin user management — admin + support, with an admin-mode `CreateUserForm`), `logs` (sport→tournament→match browser with inline SVG odds-history charts and a raw AMQP feed viewer per match), `audit`, `mapping`, `margins`, `withdrawals`, `feed` (recovery controls). Not yet reskinned; uses legacy `--color-*` tokens mapped in `@theme`. |
| Server access | [`CONNECT.md`](./CONNECT.md) |
| GitHub repo | https://github.com/alexanderchernavin-cloud/oddzilla1 (private) |
| Production server | `team@178.104.174.24` (Hetzner CPX22, Ubuntu 24.04). Repo lives at `/home/team/oddzilla`. Docker 29 + pnpm 9.12 + Node 22 installed. |
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

What's actually wired up vs scaffolded vs deferred. Last updated after the
post-Phase-8 Oddin-workflow hardening pass; production stack is live at
`team@178.104.174.24` consuming the integration AMQPS feed.

| Component | Status | Notes |
| --- | --- | --- |
| DB schema + migrations | Live | 6 migrations: init, odds_history partitions, chain_scanner_state, drop_news_articles, `0004_unclassified_sport` (hidden fallback sport + move placeholder tournaments), `0005_merge_duplicate_sports` (merge s-N auto-duplicates into seeded rows + align seed URNs with real Oddin URNs `od:sport:{1,2,3,13}`). |
| Auth (signup/login/refresh/me + password change) | Live | argon2id + JOSE JWT (`alg: HS256` pinned) + refresh-rotation; helmet CSP `default-src 'none'` on `/api/*`; rate-limited login (5/min) + signup (10/min); shared cookie domain `.oddzilla.cc`. Browser uses same-origin `/api/*` through Caddy — `NEXT_PUBLIC_API_URL` is baked **empty** so api-client falls back to `/api`. |
| Catalog API + sport/match SSR pages | Live | `/catalog/sports` filters `active=true` (hides `unclassified`); `/catalog/sports/:slug` returns inline match-winner odds per row (paired to home/away by team-name); `/catalog/matches/:id` returns all active (`status=1`) markets — provider-id whitelist removed. Odds formatted to 2 decimals via `formatOdds()`. |
| Frontend design | Live (2026-04-18) | Ported from Claude Design handoff bundle. Grid shell: top-bar + left sidebar + main + right-rail bet slip. Route groups: `(auth)` = login/signup, `(main)` = home/sport/match/account/bets/wallet, `admin/*` keeps its own layout. Sidebar order: CS2 → Dota 2 → LoL → Valorant → every other active sport (alphabetical); `efootballbots` + `ebasketballbots` are hidden via both the feed-ingester blocklist (`BLOCKED_ODDIN_SPORT_SLUGS`) and a defensive filter in `sidebar.tsx`. Tokens in `apps/web/src/app/globals.css`; legacy `--color-*` aliases kept for admin/bets/wallet pages. |
| Bet slip + placement | Live | Singles + combos (up to 20 legs, cross-match only — same-match legs rejected server-side). Always-visible right rail (`apps/web/src/components/shell/bet-slip-rail.tsx`) drives the `BetSlipProvider` store, with a Single/Combo toggle. Withdrawals also block non-active users at request time. |
| bet-delay worker | Live | LISTEN + 1s sweep + 5% drift tolerance |
| Oddin AMQP feed (feed-ingester + settlement) | Live | AMQPS over `:5672` (not 5671), vhost `/oddinfeed/{customer_id}` URL-assembled by hand to preserve `%2F`. Bookmaker 142 |
| Recovery flow | Live | `POST /v1/{product}/recovery/initiate_request` triggered on every (re)connect for both producers + on `alive subscribed=0` + on `alive` timestamp drift > 5s |
| Auto-mapping (sport/category/tournament/match) | Live | REST-driven via `GET /v1/sports/en/sport_events/{urn}/fixture`; falls back to placeholder under default sport's auto category on 404; mapping_review_queue rows for everything created |
| Pre-match → live `-2` handover sweeper | Live | feed-ingester ticks every 15s; demotes markets stuck at -2 for >60s to -1 (suspended) |
| Settlement: settle / rollback_settle / cancel / rollback_cancel | Live | Apply-once via `(event_urn, market_id, specifiers_hash, type, payload_hash)` 5-tuple |
| Settlement: cancel-after-settle | Live | bet_cancel for an already-settled market reverses the settlement first, then refunds — per Oddin docs §2.4.4 |
| Settlement: re-settle after rollback | Live | `wallet_ledger.ref_id` uses `<ticketID>:N` generation suffix to keep multi-generation payout rows distinct |
| Settlement: bet_cancel time-window | Live | start_time/end_time honored; per-ticket void filtered by `placed_at`; market status only flipped to -4 when end_time absent |
| Settlement: payout math (15 unit tests) | Live | Half-win/lost via `void_factor=0.5`, full void via `void_factor=1`, floor-rounding |
| `fixture_change` re-fetch | Live | NEW/DATE_TIME/FORMAT/COVERAGE trigger REST refresh; CANCELLED flips match status |
| Admin: mapping review | Live | `/admin/mapping` |
| Admin: payback margins | Live | `/admin/margins`, cascade market_type→tournament→sport→global |
| Admin: tickets list + manual void | Live | `/admin/tickets` API; UI page not built |
| Admin: withdrawals approve flow | Live | `/admin/withdrawals` page with approve/reject/mark-submitted/confirmed/failed; mark-confirmed pre-checks `balance >= debit` |
| Admin: PnL dashboard | Live | `/admin` with KPIs (today PnL, active users, open tickets, stakes today), 14-day PnL × sport table, top-10 big wins (30d) |
| Admin: bettor user management | Live | `/admin/users` list + `/admin/users/[id]` edit (status/role/limit/bet-delay) with self-modification guards + audit logging. View pinned to `role=user` server-side via the API's new `roles` CSV filter; admins/support are hidden here. |
| Admin: admin user management | Live | `/admin/admins` list + create flow for backoffice operators (admin + support). Calls `/admin/users` with `?roles=admin,support`. Shared `CreateUserForm` is parameterized by `mode` — `admin` mode exposes role choice and drops bettor-only knobs (bet-delay + stake limit). |
| Admin: feed logs panel | Live | `/admin/logs` sport → tournament → match hierarchy (categories joined silently — esports auto-dummies). Per match: inline SVG line charts per market over the last 24h of `odds_history`; "Feed log" button opens `/admin/logs/matches/[id]/feed` with kind-filterable `<details>` viewer of raw AMQP XML. feed-ingester writes every match-scoped kind to `feed_messages`; hourly `runFeedMessageCleanup` goroutine sweeps once retention expires. |
| Admin: audit log viewer | Live | `/admin/audit` paginated with action/target/actor filters |
| Server security hardening | Live | Non-root inside every container (`node:1000` for TS, `app:100` for Go); SSH `PasswordAuthentication no`, `PermitRootLogin no`, `MaxAuthTries 3`, `X11Forwarding no`; repo dir `chmod 750`; CSP header on Next.js HTML responses via Caddy; `NODE_ENV=production` on server so auth cookies get `Secure` flag. `fail2ban` was installed briefly then removed (kept banning legit operator connections — password auth off makes brute force impossible anyway, see `project_security_hardening.md` memory). |
| Postgres backups | Live | `/usr/local/bin/oddzilla-pg-backup` (from `infra/hetzner/backup/pg_backup.sh`) runs daily at 03:00 UTC via root cron, `docker exec` into postgres container, writes `/var/backups/oddzilla/*.sql.gz` (root:root 600), 14-day rotation. **Off-server copy is still manual** — pre-launch todo. |
| Published odds margin | Active but **0 bp globally** | `odds_config` row `scope='global'` has `payback_margin_bp=0` because Oddin already ships odds with margin baked in. `applyMargin()` divides `raw / (1 + bp/10000)` with floor-truncate to 2 decimals. Admin `/admin/margins` still works for per-sport/tournament/market-type overrides when needed. |
| Wallet HD address derivation | Live | TS, requires `HD_MASTER_MNEMONIC` |
| Wallet deposit scanners | Live, gated on RPC URLs | Boots idle if `TRON_RPC_URL` / `ETH_RPC_URL` absent |
| Wallet withdrawal on-chain submission | **Manual** | Admin marks-submitted with tx hash from external signer/wallet. Pre-launch needs a dedicated signer container |
| News scraper | **Removed** | Service + `news_articles` table deleted via migration 0003; no longer in scope |
| Combos | Live | Frontend slip accumulates selections; Single/Combo toggle; settlement pays stake × product(EffectiveFactor), `bet_refund` ledger only when every leg voids. |
| Cash-out | Live | Migration 0014 adds `cashout_config`, `cashouts`, probability columns on `market_outcomes` / `odds_history` / `ticket_selections`, and a `cashout` value on `wallet_tx_type`. Algorithm is Sportradar §2.1.1 (`stake × ticketOdds × Π(legProb)`) with optional §2.1.2 deduction ladder; full-stake prematch window is configurable per-scope. Oddin already populates `probabilities="0.368"` on every active outcome (verified on the integration broker 2026-04-28); engine falls back to `1/oddsCurrent` when the attribute is missing. Endpoints: `GET /tickets/:id/cashout/quote`, `POST /tickets/:id/cashout`, plus `/admin/cashout-config` cascade. Frontend: [`apps/web/src/app/(main)/bets/cashout-panel.tsx`](./apps/web/src/app/(main)/bets/cashout-panel.tsx) polls every 2s and surfaces an accept dialog. Settlement is unaffected — `maybeSettleTicket` already gates on `t.Status == "accepted"`, so `cashed_out` tickets are never re-paid. |
| Outright (tournament-level) markets | Not started | Auto-mapper currently falls back to placeholder for `od:tournament:N` URNs (REST `/sport_events/` only handles match URNs); flagged as Post-MVP |
| Prometheus + Grafana | Not started | Defer until traffic justifies |

## Local secrets that exist (DO NOT commit)

`D:\AI\Oddzilla\.env` (gitignored, local dev) and
`/home/team/oddzilla/.env` on the server (mode 600) hold:
- `ODDIN_TOKEN=<redacted>` (Sasha's Oddin integration token; in `.env`, never in docs)
- `ODDIN_CUSTOMER_ID=142` — fetched via `curl -H "x-access-token: $ODDIN_TOKEN" https://api-mq.integration.oddin.gg/v1/users/whoami` (note `/v1/` prefix; the legacy `/users/whoami` returns 404)
- `ODDIN_AMQP_PORT=5672` (NOT 5671 — Oddin runs AMQPS on 5672 per their docs §2)
- `ODDIN_AMQP_TLS=true`
- `JWT_SECRET` + `REFRESH_COOKIE_SECRET` — generated 48-byte secrets
- `POSTGRES_PASSWORD` — generated 64-char hex
- `NODE_ENV=production` (required so auth cookies get `Secure` flag)
- `FRONTEND_HOST=s.oddzilla.cc`, `ADMIN_HOST=sadmin.oddzilla.cc`, `ACME_EMAIL=alexander.chernavin@oddin.gg` — consumed by Caddy for per-host reverse-proxy + Let's Encrypt
- `COOKIE_DOMAIN=.oddzilla.cc` — shared cookie across both subdomains
- `CORS_ORIGINS=https://s.oddzilla.cc,https://sadmin.oddzilla.cc`
- `NEXT_PUBLIC_API_URL=` and `NEXT_PUBLIC_WS_URL=` — **both empty on prod**. Browser falls back to `/api` and `wss://<host>/ws` via Caddy. Non-empty values bake `http://localhost:3001` into the prod bundle and break in-browser auth. For local `pnpm dev`, put non-empty values in `apps/web/.env.local`.
- `HD_MASTER_MNEMONIC=` **empty** — withdrawal/deposit features inert until set. Generate any BIP39 phrase.
- `TRON_RPC_URL` defaults to `https://api.trongrid.io`
- `ETH_RPC_URL=` **empty** — ERC20 scanner inert until provided

`.gitignore` excludes `.env` and `.claude/`. The local repo IS now
git-initialized and pushed to https://github.com/alexanderchernavin-cloud/oddzilla1
(private). The server keeps an authoritative `.env` at
`/home/team/oddzilla/.env` with mode 600. **Never read .env over SSH** —
the sandbox blocks it (would dump secrets into the transcript). Patch
specific keys with `sed -i 's/^KEY=.*/KEY=value/'` instead.

## Verification commands

When in doubt that everything is wired up, run from repo root:

```bash
pnpm -r typecheck    # 9 TS workspaces (web, api, ws-gateway, 6 packages)
pnpm audit --prod    # should report 0 vulns
for svc in feed-ingester odds-publisher settlement bet-delay wallet-watcher; do
  (cd services/$svc && go vet ./... && go test ./...)
done
```

All should be silent / green. Last known good state: end of post-Phase-8
hardening pass — see [`docs/PHASES.md`](./docs/PHASES.md) for the commit-by-
commit changelog.

For the production server, after a `git push` to main:

```bash
ssh team@178.104.174.24 "cd /home/team/oddzilla && \
  git fetch origin main && git reset --hard origin/main && \
  sg docker -c 'docker compose -f docker-compose.yml build && \
                 docker compose -f docker-compose.yml up -d --force-recreate'"
```

Migrations are run with `pnpm --filter @oddzilla/db db:migrate` from the
host (Node 22 + pnpm 9.12 are installed there); the `.env` provides
`DATABASE_URL`. Skip if no schema changes shipped.

## Handoff notes for the next session

If you're a fresh agent picking this up:

1. **Read this file first** (you're here). Then skim
   [`docs/PHASES.md`](./docs/PHASES.md) for what's done and what's next.
2. **All phases 1–8 + post-Phase-8 hardening are live and deployed.**
   The news scraper was cancelled mid-Phase-8 (migration 0003 dropped
   the table; `services/news-scraper/` is gone). The next layer of work
   is the **pre-launch exit gates** — KYC, signer isolation, daily
   wallet reconciliation, backups, runbook, monitoring. These are
   blockers for accepting real user traffic, not for further dev work.
3. **Production is running.** GitHub remote is
   https://github.com/alexanderchernavin-cloud/oddzilla1 (private).
   Server is `team@178.104.174.24` with the full Docker Compose stack
   live. Connected to Oddin's integration broker (bookmaker 142) via
   AMQPS on 5672. See "Verification commands" above for the redeploy
   recipe.
4. **Before touching anything money-related**, re-read invariants 3 + 4
   above. The two-layer apply-once (settlements unique 5-tuple + ledger
   unique partial index, with the new `<ticketID>:N` generation suffix
   for re-settlements) is what keeps the books consistent under crash,
   replay, and race conditions.
5. **Don't trust phase comments inside source files** — phase progress
   moved fast. CLAUDE.md's "Live phase status" table is the truth.
6. **When debugging the Oddin feed, always test from inside a container
   on the compose network** (`docker compose exec feed-ingester sh -c
   "..."`) and from the host. Diagnostic asymmetry between the two
   (e.g. one can resolve `mq.integration.oddin.gg` and the other can't)
   has been a recurring source of confusion.
7. **Auto mode caveat.** The sandbox blocks reading the production
   `.env` over SSH (rightly — would dump secrets to transcript). Patch
   single keys with `sed`; don't `cat .env`.
8. **Browser auth debugging.** If login/signup fails with "Could not
   reach the server", first suspect `NEXT_PUBLIC_API_URL` baked into
   the web bundle. Verify with
   `curl -s https://s.oddzilla.cc/_next/static/chunks/... | grep localhost:3001`
   — zero hits means the bundle is clean. The fix is to keep empty
   defaults in [`apps/web/next.config.ts`](./apps/web/next.config.ts).
9. **Design system.** Tokens live in
   [`apps/web/src/app/globals.css`](./apps/web/src/app/globals.css);
   primitives in
   [`apps/web/src/components/ui/primitives.tsx`](./apps/web/src/components/ui/primitives.tsx).
   The shell (`top-bar`, `sidebar`, `bet-slip-rail`) wraps everything
   under `app/(main)/`. Sports order in `sidebar.tsx`: slugs in the `TOP`
   array are pinned to the top; everything else is alphabetical; slugs
   in `HIDDEN` never render (currently `efootballbots` +
   `ebasketballbots`, matching the feed-ingester `BLOCKED_ODDIN_SPORT_SLUGS`
   default). Admin / wallet / bets still use legacy Tailwind classes
   against the `@theme`-bridged color tokens; reskin them when the
   design gets extended.
10. **Odds margin.** Globally **0 bp** today — Oddin already margins.
    If the user asks to add house margin, do it via
    `/admin/margins` (cascade market_type→tournament→sport→global)
    rather than touching code. Per-user margin would be a new column
    (`users.margin_bp_override`) + a branch in
    `odds-publisher/internal/publisher/publisher.go` `processOne`.
