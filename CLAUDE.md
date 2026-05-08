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
| Which chains? | USDC on ERC20 (Ethereum) only. Migration 0032 renamed the currency from USDT and dropped Tron + per-user HD addresses. |
| Where does it run? | Hetzner CPX22 at `178.104.174.24` (see [`CONNECT.md`](./CONNECT.md)). Public URLs: **`oddzilla.cc`** (storefront, apex) + **`sadmin.oddzilla.cc`** (admin; `/` redirects to `/admin`). The legacy `s.oddzilla.cc` host 301s to the apex via a hard-coded Caddyfile block — drop the block and DNS record once the old subdomain stops receiving traffic. Let's Encrypt via Caddy. |
| How is money stored? | `BIGINT _micro` (6 decimals = 1,000,000 micro per unit) on every wallet/ledger/ticket row, with a sibling `currency CHAR(4)`. Two currencies: `USDC` (real, on-chain via ERC20) and `OZ` (demo, every signup gets a 1000 OZ bonus for testing the bet flow). Withdrawals + deposits stay USDC-only. |
| Auth? | Email + password (argon2id), JWT access (15 min) + refresh cookie (30 d). `Domain=.oddzilla.cc` so session works on both subdomains. |
| UI aesthetic? | Premium / quiet editorial: Instrument Serif display + Geist UI + Geist Mono for odds. Light theme default (`#f4f2ec`), dark via `data-theme="dark"` (toggle in the top bar; choice persists in `localStorage["oz:theme"]`). Ported from the Claude Design handoff bundle. **No emojis.** |

Current phase: **Phases 1–8 complete + security hardening + catalog cleanup
+ frontend redesign + USDC payments rewrite (migration 0032).** News
scraper was cancelled during Phase 8 (migration 0003). The site went
live at `s.oddzilla.cc` on 2026-04-18 and moved to the apex
`oddzilla.cc` shortly after; market whitelist active, and
`payback_margin_bp=0` globally (Oddin already sends margined odds —
see [`docs/OPERATIONS.md`](./docs/OPERATIONS.md) before re-enabling).
Migration 0032 (2026-05-07) replaced the per-user HD-address USDT
flow with a single shared ERC20 address + user-submitted tx-hash
attribution; wallet-watcher is now intent-driven. Next: pre-launch
exit gates (KYC, wallet reconciliation, off-server backup rsync,
monitoring, runbook). Full roadmap in
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

Browser ── /widgets/* (api proxy, x-brand-token) ──► Oddin Disir REST
                                                       └─► returns iframe URL for
                                                           prematch / live widgets
```

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full picture, and
[`docs/ODDIN.md`](./docs/ODDIN.md) for the Oddin protocol details.

## Tech stack (locked)

- **Go 1.23** — `services/{feed-ingester, odds-publisher, settlement, bet-delay, wallet-watcher, signer}`.
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

1. **Money is `BIGINT _micro` (6 decimals) per currency.**
   Column suffix is `_micro`. Never `NUMERIC` for balances/stakes. Never
   `number` in TS (precision loss > 2^53). Use the `MicroUsdt` branded bigint
   from `packages/types/src/money.ts` for arithmetic (the math is currency-
   agnostic — OZ also has 6 decimals). JSON serialization: bigints go over
   the wire as decimal strings (`"10000000"` not `10000000`).

   Every wallet read/write is scoped by `(user_id, currency)` since
   migration 0014. Forgetting the `currency` filter on a `wallets` /
   `wallet_ledger` query will silently touch the wrong row. The supported
   set is hard-coded in
   [`packages/types/src/currencies.ts`](./packages/types/src/currencies.ts)
   (`SUPPORTED_CURRENCIES = ["USDC", "OZ"]`). Withdrawals + on-chain
   deposits hard-code `currency='USDC'`; OZ has no chain.

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
| Oddin BetBuilder (OBB) gRPC client | [`services/api/src/lib/obb-client.ts`](./services/api/src/lib/obb-client.ts) — wraps the vendored `proto/obb/*.proto` (`AvailableMarkets` / `SessionCreate` / `SessionInfo`) with a singleton gRPC channel. Per-RPC `token` metadata key carries the Oddin access token. Graceful-idle: when `ODDIN_OBB_HOST` is empty the factory returns null and `/betbuilder/*` 503s `betbuilder_disabled`. |
| BetBuilder routes (storefront → OBB proxy) | [`services/api/src/modules/betbuilder/routes.ts`](./services/api/src/modules/betbuilder/routes.ts) — `GET /betbuilder/match/:id/markets` (toggle visibility probe), `POST /betbuilder/match/:id/quote` (SessionCreate; returns combined session odds + OBB-eligible markets, mapped back to internal market ids via `(provider_market_id, specifiers_hash)` so the slip can render against existing buttons). |
| BetBuilder placement (POST /bets) | [`services/api/src/modules/bets/service.ts`](./services/api/src/modules/bets/service.ts) — `betType="betbuilder"` + `betBuilder` block (sessionId / expectedOddsX10000 / selectionIds). Server bypasses the same-match guard, asserts every leg comes from one match, calls OBB `SessionInfo` to revalidate, then debits stake. Frozen `BetBuilderMeta` lands on `tickets.bet_meta`. |
| BetBuilder toggle (match page) | [`apps/web/src/components/match/betbuilder-toggle.tsx`](./apps/web/src/components/match/betbuilder-toggle.tsx) — sport-gated (CS2 / Valorant / eFootball / eBasketball per OBB doc Appendix #1) and silently hidden when `/betbuilder/match/:id/markets` 503/404s. Toggling ON puts the slip in `mode: "betbuilder"` for that match; off reverts to combo/single. |
| BetBuilder slip mode | [`apps/web/src/lib/bet-slip.tsx`](./apps/web/src/lib/bet-slip.tsx) — `mode: "betbuilder"` plus `betbuilderMatchId` + `betbuilderQuote`. While in builder mode `add()` accepts multiple legs from the SAME match (skipping the default same-match replace); picking a leg from a different match drops every builder leg and reverts to combo. |
| BetBuilder rail rendering | [`apps/web/src/components/shell/bet-slip-rail.tsx`](./apps/web/src/components/shell/bet-slip-rail.tsx) — re-quotes `/betbuilder/match/:id/quote` whenever the leg set changes, shows the combined session odds, and submits with the `betBuilder` block. |
| BetBuilder settlement payout | [`services/settlement/internal/settler/payout.go`](./services/settlement/internal/settler/payout.go) `BetBuilderPayout` — all-won → `stake × oddsX10000/10_000` (bet_payout); any leg lost → 0; any leg voided + rest non-loss → refund stake (bet_refund) since OBB combined odds aren't a product and we can't recompute on partial voids. |
| OBB proto schema (vendored from `oddin-gg/obbschema`) | [`services/api/proto/obb/`](./services/api/proto/obb/) — `service.proto`, `session.proto`, `markets.proto`, `popular.proto`. Loaded at runtime via `@grpc/proto-loader`; not committed as generated code. |
| RiskZilla engine (TS) | [`services/api/src/lib/riskzilla/engine.ts`](./services/api/src/lib/riskzilla/engine.ts) — runs inside the bet placement transaction, evaluates min stake, max payout, per-tier match liability cap, per-bettor slice (bet_factor × match_cap × RS, with VIP damping above RS 3 mirroring Oddin OTS §8.3.2.1), bank limit, and per-market factor; on accept bumps `riskzilla_bank_state.open_liability_micro` and writes `riskzilla_event_log`; on reject the placement tx rolls back, then BetsService writes the event_log row outside the rolled-back tx and throws a typed `BadRequestError`. **Bank gate is the strict version**: `bet_max_loss + open_liability + Σ wallet.balance_micro (USDC) ≤ bank_limit_micro`. Bettor wallet balances are withdrawable on demand and count against the operator's risk capital — accepting a bet that would push committed capital (balances + open potential payouts + this bet) over the bank limit is rejected with `bank_limit_exceeded` even if the simpler `open_liability + bet ≤ bank_limit` form would otherwise pass. The dashboard + bank pages surface the breakdown as `Bank limit / Bettor balances / Open liability / Free capacity` with `Free` going red when the operator is over-committed. `services/settlement/internal/store/store.go` `UpdateRiskzillaBankOnSettle` / `UpdateRiskzillaBankOnReverse` move `bank_limit_micro` and decrement `open_liability_micro` on every settle / cancel / rollback, idempotent on a `<ticketID>:N` ref_id suffix shared with `wallet_ledger`. |
| RiskZilla admin routes (TS) | [`services/api/src/modules/admin/riskzilla/routes.ts`](./services/api/src/modules/admin/riskzilla/routes.ts) — sub-modules `settings`, `bank`, `bettors`, `events`, `dashboard`. Bank-limit edit (`PUT /admin/riskzilla/bank/limit`) and `/admin/riskzilla/bank/recompute` are extra-gated to a single admin email (`q1qooo@gmail.com`) — anyone else with admin role gets a `bank_admin_only` 403. Every mutation writes `admin_audit_log`. |
| RiskZilla admin pages (web) | [`apps/web/src/app/admin/riskzilla/`](./apps/web/src/app/admin/riskzilla/) — `page.tsx` (dashboard KPIs + bank utilisation + top exposure by match + bettor RS histogram), `settings/`, `market-factors/`, `bank/`, `betticker/` (live tail polling every 3 s with status + reason filter pills + pause), `bets/` (historical search w/ date-range + cursor pagination), `bettors/` + `bettors/[id]/` (list + per-bettor profile with RS editor). Sidebar entry under **Risk & limits → RiskZilla**. |
| SQL migrations | [`packages/db/migrations/`](./packages/db/migrations/) — `0000_init`, `0001_odds_history_partitions`, `0002_chain_scanner_state`, `0003_drop_news_articles`, `0004_unclassified_sport`, `0005_merge_duplicate_sports`, `0006_market_descriptions`, `0007_purge_non_mvp_sports` (superseded by 0012), `0008_competitors` (teams as first-class per-sport entities), `0010_odds_config_global_unique`, `0011_feed_messages` (raw AMQP message log keyed to match for the `/admin/logs` panel; uniform 7-day retention since `received_at`, with a periodic backfill that re-resolves `match_id` for rows whose URN now maps — closes the insert/auto-map race that previously left orphan rows hidden), `0012_reactivate_non_bot_sports` (re-enables every non-bot sport after the product opened past the 4-MVP scope), `0013_tournament_risk_tier`, `0014_multi_currency` (composite PK on `wallets`; `currency CHAR(4)` on `wallet_ledger` + `tickets`; OZ demo currency), `0015_cashout` (cashout cascade + probability columns + `cashouts` table), `0016_cashout_acceptance_delay`, `0017_tiple_tippot` (tiple/tippot bet products + per-scope `bet_product_config`), `0018_bet_product_per_leg_margin` (`bet_product_config.margin_bp_per_leg`; effective margin compounds multiplicatively as `(1 + margin_bp) × (1 + margin_bp_per_leg)^N − 1` — same shape a combo's overround takes via its odds product, so Tippot's all-wins multiplier stays below an equivalent combo), `0019_fe_market_display_order` (per-sport storefront ordering of market types — `(sport_id, provider_market_id) → display_order`; consulted by `/catalog/matches/:id`, configured at `/admin/fe-settings/markets-order`), `0020_fe_market_order_scope` (adds `scope` column to `fe_market_display_order` distinguishing `match` / `map` / `top`; admin maintains a separate ordering per scope, and the curated `top` list synthesises a "Top" tab on the match-detail page + an inline Top toggle on match list cards), `0021_competitor_logos` (`competitors.logo_url` + `competitors.brand_color` for storefront team branding; admins manage them at `/admin/competitors`), `0022_match_tv_channels` (`matches.tv_channels jsonb` storing the parsed `<tv_channels>` block from Oddin's fixture endpoint; Twitch / YouTube broadcasters render as a live-stream embed above the markets on the match-detail page, fixture_change `STREAM_URL` (106) now triggers a REST refresh), `0023_settlements_market_id_idx` (plain btree on `settlements(market_id)` so reverse-FK probes by market_id can use an index — the existing `(event_urn, market_id, …)` unique can't because event_urn leads. Without it, the recovery flush's `NOT EXISTS` over 4M settlement rows seq-scanned and ran for over a minute, holding row locks on `markets` that blocked feed-ingester and settlement INSERTs.), `0024_community_profiles` (Phase 10.1 — `users.tickets_public BOOL DEFAULT TRUE` (Decision D1), `users.nickname citext UNIQUE`, `users.bio TEXT`, `users.is_ai BOOL DEFAULT FALSE`. CHECK constraints mirror the API zod cap on bio length (≤280) and the `[A-Za-z0-9_]{3,20}` nickname format. `is_ai` is an internal flag for AI seed accounts in Phase 10.4 and is never serialised by any API endpoint per Decision D2.), `0025_community_tickets` (Phase 10.2 — `community_tickets` denormalised read-projection of publicly-resolved tickets driving the `/community` feed. `UNIQUE (ticket_id)` + `ON CONFLICT DO UPDATE` makes the upsert idempotent under settlement replay; rollback / re-settle generations update the same row. `sport_ids INTEGER[]` (GIN-indexed) carries the per-ticket sport set computed by joining `ticket_selections → markets → matches → tournaments → categories`. Authoritative writer is `services/settlement` (Go) inside `SettleTicket` / `ReverseSettledTicket`; cashout (`services/api`, TS) writes inline; admin `POST /admin/community/backfill` recovers any miss.), `0026_audit_hardening` (security audit PR #130 — 4-eyes on `withdrawals` via `approved_by_user_id` / `submitted_by_user_id` / `confirmed_by_user_id` columns + `withdrawals_distinct_approver_confirmer` CHECK enforcing `confirmed_by ≠ approved_by`; unique partial index on `(network, tx_hash) WHERE tx_hash IS NOT NULL` so a duplicate hash is rejected at DB layer; tamper-evident `admin_audit_log` via `prev_hash` + `row_hash BYTEA` columns and a BEFORE INSERT trigger building a SHA-256 chain over the canonical row payload (advisory-locked so concurrent inserts serialise). Verifier function `admin_audit_chain_check()` returns `(id, ok)` per row — any `ok=false` means the row was tampered with after insert. Migration backfills existing rows so the chain is valid from row 1.), `0027_deposit_reorg_safety` (security audit PR #130 — `deposits.block_hash TEXT` captured at insert time so the wallet-watcher processor can verify the canonical chain still contains the same block before crediting; reorg drops the block → row flips to `status='orphaned'` instead of crediting. Nullable; pre-migration rows skip-verify.), `0028_session_family` (security audit PR #130 — `sessions.family_id UUID NOT NULL` + `parent_session_id UUID` for refresh-token replay detection. Login starts a fresh family; refresh continues an existing one. If a refresh is presented for a session that's ALREADY revoked, we revoke the entire family — canonical detection of stolen-token reuse. Backfill: each existing session is its own family root.), `0029_community_achievements` (Phase 10.4 — `achievement_definitions` (id TEXT PK, title, description, icon lucide-slug, sort_order) + `user_achievements` (`(user_id, achievement_id)` composite PK for idempotent unlocks; cascade on user delete). 5 starter badges seeded: `first_win`, `combo_5`, `odds_20`, `payout_100x`, `streak_10`. Currency-agnostic predicates run after every projection write across Go settle, TS cashout, and admin backfill paths.), `0031_betbuilder` (Oddin BetBuilder same-match combo product — extends the `bet_type` enum with `'betbuilder'`. Session id + frozen combined odds ride in `tickets.bet_meta` jsonb (same convention tiple/tippot use). No new columns: settlement reads `bet_meta` for the OBB session multiplier, bet-delay branches on `bet_type::text` to skip per-leg drift), `0032_usdc_payments` (currency rename USDT → USDC across `wallets` / `wallet_ledger` / `tickets` rows + their column DEFAULTs; drops the legacy per-user `deposit_addresses` table; adds `deposit_intents` (user-submitted tx-hash claims with status pending/confirming/credited/rejected) which is the new attribution channel for the single shared ERC20 receive address; deletes the dormant TRC20 `chain_scanner_state` row. `chain_network` enum still carries the TRC20 value but no code path produces it any more. The legacy `deposits` table is left in place dormant — the wallet-watcher rewrite reads/writes only `deposit_intents`), `0037_riskzilla` (internal Risk Management Service — `riskzilla_settings` per-tier defaults (Match Liability / Min Bet / Max Payout / Bet Factor; tier 0 is the global fallback, 1–10 mirror Oddin tournament `risk_tier` (column allows up to 32 for headroom)), `riskzilla_market_factors` per-Oddin-market multiplier in [0, 1] (down-only — 0 hard-rejects bets on that market type), `riskzilla_bank_state` singleton (`bank_limit_micro` running operator bankroll + `open_liability_micro` cached sum of worst-case loss across open tickets), `riskzilla_bank_ledger` append-only audit (`seed`, `bet_loss`, `bet_payout`, `bet_refund`, `manual_adjust`; idempotent unique partial index on (type, ref_type, ref_id)), `riskzilla_event_log` every accept/reject decision powering both the live Betticker and historical Bets viewer, and `users.risk_score numeric(4,3)` per-bettor multiplier (range 0.01–10, default 1.000) consumed by the engine with VIP damping above RS 3 mirroring Oddin OTS §8.3.2.1 BOS/OAF). |
| Drizzle schema | [`packages/db/src/schema/`](./packages/db/src/schema/) |
| Seed script | [`packages/db/src/seed.ts`](./packages/db/src/seed.ts) — seed sport URNs are `od:sport:{3,2,1,13}` matching real Oddin feed (do NOT revert to synthetic `od:sport:cs2` etc. — it breaks auto-mapping) |
| Money helpers | [`packages/types/src/money.ts`](./packages/types/src/money.ts) |
| Currency list + demo bonus | [`packages/types/src/currencies.ts`](./packages/types/src/currencies.ts) (`SUPPORTED_CURRENCIES`, `SIGNUP_BONUS_OZ_MICRO`) |
| Specifier canonicalization (TS reference) | [`packages/types/src/specifiers.ts`](./packages/types/src/specifiers.ts) |
| Specifier golden fixture | [`docs/fixtures/specifiers.json`](./docs/fixtures/specifiers.json) |
| Shared API/WS/bet/wallet types | [`packages/types/src/`](./packages/types/src/) |
| Auth helpers (argon2id + JOSE JWT) | [`packages/auth/src/`](./packages/auth/src/) — `password.ts` (argon2id m=46 MiB / t=1 + `verifyDummyPassword` for login-timing equalisation), `jwt.ts` (HS256 pinned, `aud=oddzilla-api`) |
| Env parsing (zod) | [`packages/config/src/env.ts`](./packages/config/src/env.ts) |
| API plugins (db, redis, auth, csrf) | [`services/api/src/plugins/`](./services/api/src/plugins/) — `db.ts` (drizzle), `redis.ts`, `auth.ts` (JWT verify + Redis-cached session-revocation check, `SESSION_STATUS_KEY` exported so revoke paths can flip the cache to `revoked`), `csrf.ts` (Origin/Referer must match `CORS_ORIGINS` for every POST/PUT/PATCH/DELETE — same-site fetch always sets Origin, so legitimate traffic is unaffected) |
| API route modules | [`services/api/src/modules/`](./services/api/src/modules/) — `auth`, `users`, `wallet`, `bets`, `catalog`, `admin/{routes,odds-config,tickets,withdrawals,dashboard,users,audit,feed,logs,fe-settings,competitors,community}`, `community` (Phase 10.1–10.3 — `GET /community/feed?sort=recent\|best&currency=&sport=`, `GET /community/users/:nickname/{profile,tickets}`, `GET /community/me`, `PATCH /community/me/{visibility,profile}`, `POST /community/copy/:communityTicketId`; admin `POST /admin/community/backfill`), `widgets` (Oddin Disir proxy — `GET /widgets/match/:id/prematch`, `GET /widgets/tournament/:id/prematch`, `GET /widgets/match/:id/live`; returns `{url}` for the storefront iframe `src`. The `x-brand-token` is held only by the api process and never reaches the browser. URLs cache in Redis for 120s with key `disir:url:{kind}:{env}:{urn}:{qs}`. When `DISIR_BRAND_TOKEN` is empty, all three routes 503 `widget_disabled` and the storefront silently skips rendering — same gracefully-degrades pattern wallet-watcher uses without an RPC URL.). `users` accepts `?roles=admin,support` (CSV) for the Admin user-management view. `logs` powers the sport→tournament→match browser with per-match odds-history + raw feed-message endpoints. `fe-settings` exposes storefront-display knobs (currently per-sport market order). `competitors` exposes team-branding management (`GET /admin/competitors`, `PATCH /admin/competitors/:id`, `POST /admin/competitors/bulk-logos`). |
| Disir widget React components | [`apps/web/src/components/widgets/`](./apps/web/src/components/widgets/) — `disir-widget.tsx` (generic iframe wrapper that fetches the URL from `/widgets/*`, listens to the doc-defined `LOADED`/`RESIZE`/`DATA`/`CLOSE`/`SCROLL_TOP` postMessage events, hides itself until DATA:true for live widgets), `rail-prematch-panel.tsx` (renders below the bet slip in the right rail on desktop; reads `MatchPageContext`), `match-prematch-mobile.tsx` (mobile-only inline toggle on the match page — collapsed by default, expanded by button under the match info above the markets), `match-live-media.tsx` (combines Twitch/YouTube embed + live scoreboard widget; desktop stacks both, mobile pill-toggles between them), `supported-sports.ts` (sport-slug allowlist mirroring the doc table — prematch: cs2/dota2/lol/valorant/efootball; live: + ebasketball/ecricket). Mounted via `MatchPageProvider` ([`apps/web/src/lib/match-page-context.tsx`](./apps/web/src/lib/match-page-context.tsx)) in `(main)/layout.tsx`; the match page uses `<MatchPageRegistrar>` to publish the active match into the context so the persistent rail picks it up. |
| HD wallet derivation (Go, isolated container) | [`services/signer/`](./services/signer/) — holds `HD_MASTER_MNEMONIC`, exposes `POST /derive` and `POST /sign` over a Unix socket on a tmpfs volume shared only with the API container. Parity-tested against the canonical BIP44 abandon-mnemonic test vector for ETH (m/44'/60'/0'/0/0 → 0x9858EfFD232B4033E47d90003D41EC34EcaEda94) and the matching Tron derivation. |
| HD wallet utilities (TS, no-secret helpers) | [`services/api/src/lib/hdwallet.ts`](./services/api/src/lib/hdwallet.ts) — only `userIndexFromUUID` + `derivationPath` + a re-export of the signer client; the actual derivation lives in the signer. |
| Signer client (TS, undici over Unix socket) | [`services/api/src/lib/signer-client.ts`](./services/api/src/lib/signer-client.ts) |
| Oddin XML structs (Go) | `services/feed-ingester/internal/oddinxml/` (msg + fixture decoders; also duplicated in `services/settlement/internal/oddinxml/`) |
| Oddin REST client (Go) | `services/feed-ingester/internal/oddinrest/` — `WhoAmI`, `Fixtures`, `SportEventFixture`, `Sports`, `SnapshotRecovery`, `InitiateRecovery` |
| Auto-mapping resolver (Go) | `services/feed-ingester/internal/automap/` — REST-driven sport/category/tournament/match auto-creation; `RefreshFromFixture` for fixture_change re-fetch |
| Recovery + alive-gap + handover sweeper | `services/feed-ingester/internal/handler/handler.go` (`TriggerRecovery`, `AliveState`, `mapFixtureStatus`, `handleMatchStatusChange`); `services/feed-ingester/cmd/feed-ingester/main.go` (`runHandoverSweeper`, `runRecoveryListener`, `runFixtureRefreshListener`). Two NOTIFY channels: `feed_recovery` (full AMQP replay) and `fixture_refresh` (single-URN REST refetch). No periodic phantom-drain — `<sport_event_status>` inside every `odds_change` is the lifecycle source of truth, and a stuck match is a real bug to surface, not noise to mop up. |
| Live scoreboard (per-map score + current-map indicator) | `services/feed-ingester/internal/oddinxml/messages.go` (`SportEventStatus`, `PeriodScores`, `PeriodScore`, `Scoreboard` decode the `<sport_event_status>` block carried inside every `odds_change`); `services/feed-ingester/internal/handler/livescore.go` (`buildLiveScore`, `deriveCurrentMap` write the persisted JSON shape); `services/feed-ingester/internal/store/catalog.go` (`UpdateMatchLiveScore` writes `matches.live_score` jsonb); rendered by `apps/web/src/app/(main)/match/[id]/page.tsx` (`MapScoreboard` with per-map rounds/kills, current-map highlight + secondary scoreboard line for live map). Persisted JSON keeps top-level `home`/`away` for back-compat with the list-card `match-row.tsx`. See [`docs/ODDIN.md`](./docs/ODDIN.md#live-scoreboard-sport_event_status). |
| Match lifecycle apply (forward-only) | `services/feed-ingester/internal/store/catalog.go` (`UpdateMatchStatus` — SQL guard rejects regressions from `closed`/`cancelled` and to `not_started`; `UpdateAllMarketsStatusForMatch` exists for the rarely-emitted `bet_stop groups="all"`); `services/feed-ingester/internal/handler/handler.go` (`handleOddsChange` forwards every `<sport_event_status status="…"/>` code through `UpdateMatchStatus` so `not_started → live → closed/cancelled` transitions land in real time; `handleBetStop` and `handleMatchStatusChange` are no-ops for bookmaker 142 since the broker doesn't emit those types — kept as graceful handlers for bookmakers that do); `services/settlement/internal/store/store.go` (`MarkMatchClosedIfAllMarketsTerminal` — flips match to `closed` when no market remains at `1/0/-1/-2`, called from both `handleBetSettlement` and `handleBetCancel`). No background reconciliation: a match that drifts out of sync with the AMQP feed is a real bug to debug, not noise to paper over. |
| Settlement payout math + tests | `services/settlement/internal/settler/payout.go` |
| Settlement workflows (settle + cancel + rollbacks + cancel-after-settle + per-generation ledger refs) | `services/settlement/internal/settler/settler.go`; `services/settlement/internal/store/store.go` (`nextPayoutRefID`, `LatestUnreversedPayoutRefID`) |
| Bet-delay evaluator + tests | `services/bet-delay/internal/worker/worker.go` |
| Chain scanners (Go) | `services/wallet-watcher/internal/{ethereum,tron}/`; shared confirmation tick in `internal/deposits/` |
| Frontend live-odds + ticket WS | [`apps/web/src/lib/use-live-odds.ts`](./apps/web/src/lib/use-live-odds.ts), [`use-ticket-stream.ts`](./apps/web/src/lib/use-ticket-stream.ts) |
| Frontend bet slip store | [`apps/web/src/lib/bet-slip.tsx`](./apps/web/src/lib/bet-slip.tsx) |
| Bet slip right-rail UI | [`apps/web/src/components/shell/bet-slip-rail.tsx`](./apps/web/src/components/shell/bet-slip-rail.tsx) |
| Shell components | [`apps/web/src/components/shell/`](./apps/web/src/components/shell/) — `top-bar.tsx`, `top-bar-search.tsx` (debounced global search popover), `sidebar.tsx` (auto-expands tournament sub-tree under the active sport), `bet-slip-rail.tsx`, `theme-toggle.tsx` |
| UI primitives | [`apps/web/src/components/ui/`](./apps/web/src/components/ui/) — `primitives.tsx` (Button, Pill, LiveDot, Tabs, OddButton, TeamMark with optional `logoUrl` prop and graceful onError fallback to initials, Divider), `icons.tsx`, `monogram.tsx`, `sport-glyph.tsx`, `tier-mark.tsx` (gold "Top" star + `isFeaturedTier()` predicate for Oddin `risk_tier ∈ {1,2}`; rendered next to the tournament name on match cards, the sidebar tournament tree, top-bar search hits, and the match-detail header. Featured cards also pick up a 2px gold left-edge accent and a "TOP" pill on the detail page; both tiers share one visual treatment per the user's "просто Top для обоих этих тиров" call) |
| Match-row component | [`apps/web/src/components/match/match-row.tsx`](./apps/web/src/components/match/match-row.tsx) |
| Server-side fetch (cookie-forwarded) | [`apps/web/src/lib/server-fetch.ts`](./apps/web/src/lib/server-fetch.ts), [`lib/auth.ts`](./apps/web/src/lib/auth.ts) |
| Browser API/WS clients | [`apps/web/src/lib/api-client.ts`](./apps/web/src/lib/api-client.ts) (empty `NEXT_PUBLIC_API_URL` → `/api` prefix; in dev set `.env.local`), [`ws-client.ts`](./apps/web/src/lib/ws-client.ts) (empty `NEXT_PUBLIC_WS_URL` → `wss://<host>/ws`) |
| Design tokens + Tailwind @theme bridge | [`apps/web/src/app/globals.css`](./apps/web/src/app/globals.css) |
| Route groups | `apps/web/src/app/{(main),(auth)}/` — `(main)` shares the shell, `(auth)` = login/signup, `admin/*` outside both |
| Admin pages (web) | [`apps/web/src/app/admin/`](./apps/web/src/app/admin/) — `page.tsx` (PnL dashboard), `users` (Bettor user management — pinned to `role=user`), `users/[id]` (edit; breadcrumb routes back to Bettors or Admins per role), `admins` (Admin user management — admin + support, with an admin-mode `CreateUserForm`), `logs` (sport→tournament→match browser with inline SVG odds-history charts and a raw AMQP feed viewer per match), `audit`, `mapping`, `margins`, `withdrawals`, `feed` (recovery controls), `fe-settings` (storefront-display knobs; first sub-section: `markets-order` per-sport ordering of market types), `competitors` (team logos + brand colours; sport-filterable list with inline edit, missing-logo toggle, and a bulk-seed endpoint). Not yet reskinned; uses legacy `--color-*` tokens mapped in `@theme`. |
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
- **Docs stay in sync on every merge.** Before a PR lands, check whether
  CLAUDE.md, the relevant `docs/*.md`, the root `README.md`, and any
  affected `services/*/README.md` still describe reality, and update
  them in the *same* PR — never "in a follow-up". Stale docs are worse
  than missing ones: they mislead the next agent. Trigger map:
  - New service, data flow, or invariant → CLAUDE.md (`## Architecture
    map`, `## Invariants`, `## Where things live`) + `docs/ARCHITECTURE.md`.
  - Schema migration → CLAUDE.md migration list under `## Where things
    live` + `docs/SCHEMA.md`.
  - Env var added / renamed / removed → `.env.example` + CLAUDE.md
    `## Local secrets that exist`.
  - Phase progress, new component shipped, acceptance bar reached →
    `docs/PHASES.md` + the CLAUDE.md `## Live phase status` table.
  - Deploy / backup / runbook / incident step changed →
    `docs/OPERATIONS.md`.
  - Oddin protocol detail changed → `docs/ODDIN.md`.
  - Service-internal change (new module, renamed binary, added flag) →
    that service's `services/<name>/README.md`.
  - File or symbol renamed / removed → grep `CLAUDE.md README.md docs/`
    and the service READMEs for the old name and either update or
    delete the references.

  If a doc claim is no longer true, fix it in the same merge. When
  reviewing, treat "diff touches code but no doc" as a smell — ask
  whether one of the triggers above applies before approving.

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
- **The signer container is the only place `HD_MASTER_MNEMONIC` lives.**
  PR #132 moved derivation out of the API into [`services/signer/`](./services/signer/).
  The API talks to it over a Unix socket on a tmpfs volume; no
  other container mounts it. Putting `HD_MASTER_MNEMONIC` back into
  the API's env (or compose service entry) defeats the entire isolation
  layer — if you find yourself needing to, talk to the signer instead.
  The signer also calls `os.Unsetenv("HD_MASTER_MNEMONIC")` at boot so
  `/proc/<pid>/environ` is uninteresting after startup.
- **Don't disable the audit-log trigger.** `admin_audit_log_chain_trg`
  computes `prev_hash` + `row_hash` on every INSERT under an advisory
  lock. Bypassing it (e.g. via `ALTER TABLE … DISABLE TRIGGER`) breaks
  the chain at every later row, and the verifier (`admin_audit_chain_check`)
  will flag every subsequent insert as tampered.
- **Don't bypass the CSRF plugin.** Every state-changing API request
  (POST / PUT / PATCH / DELETE) must carry an `Origin` or `Referer` in
  `CORS_ORIGINS`. Server-to-server callers (the Next.js middleware's
  `/auth/refresh` fetch, the web container's `/auth/me` lookup) set
  `origin` explicitly. Browsers always set Origin on POST. If you find
  yourself adding a route that needs to skip the gate, surface the use
  case first — almost certainly you want a webhook signature instead.

## Live phase status

What's actually wired up vs scaffolded vs deferred. Last updated after the
post-Phase-8 Oddin-workflow hardening pass; production stack is live at
`team@178.104.174.24` consuming the integration AMQPS feed.

| Component | Status | Notes |
| --- | --- | --- |
| DB schema + migrations | Live | 30 migrations 0000–0029. See "SQL migrations" row above for the full list. Recent additions: `0014_multi_currency`, `0015_cashout`, `0017_tiple_tippot`, `0018_bet_product_per_leg_margin`, `0019_fe_market_display_order`, `0020_fe_market_order_scope`, `0021_competitor_logos`, `0022_match_tv_channels`, `0023_settlements_market_id_idx`, `0024_community_profiles` (Phase 10.1), `0025_community_tickets` (Phase 10.2), `0026_audit_hardening` (4-eyes withdrawals + audit-log SHA-256 hash chain), `0027_deposit_reorg_safety` (`deposits.block_hash`), `0028_session_family` (refresh-token family + replay detection), `0029_community_achievements` (Phase 10.4 — `achievement_definitions` + `user_achievements`; 5 starter badges seeded). |
| Auth (signup/login/refresh/me + password change) | Live | argon2id (m=46 MiB / t=1) + JOSE JWT (`alg: HS256` pinned, `aud=oddzilla-api`) + refresh-rotation with **family-based replay detection** (presenting a refresh token whose session is already revoked → revoke the whole family); helmet CSP `default-src 'none'` on `/api/*`; rate-limited login (5/min, with timing-equalised dummy hash on unknown email) + signup (10/min) + password change (5/5min); shared cookie domain `.oddzilla.cc`; **Origin/Referer-based CSRF** on every state-changing method via [`plugins/csrf.ts`](./services/api/src/plugins/csrf.ts); **per-request session-revocation check** with Redis-cached `session:status:{sid}` (60s TTL) so logout / password change / refresh-replay invalidate the access JWT immediately instead of waiting up to 15 min. Web container no longer carries `JWT_SECRET` — `apps/web/src/lib/auth.ts` calls `/auth/me` for every check. Browser uses same-origin `/api/*` through Caddy — `NEXT_PUBLIC_API_URL` is baked **empty** so api-client falls back to `/api`. Signup also creates a USDT wallet (zero) + OZ wallet (1000 OZ demo bonus) atomically, with an idempotent `(adjustment, signup_bonus, user_id)` ledger row. |
| Catalog API + sport/match SSR pages | Live | `/catalog/sports` filters `active=true` (hides `unclassified`); `/catalog/sports/:slug` returns inline match-winner odds per row (paired by Oddin outcome_id: `"1"`=home, `"2"`=away) and accepts `?tournament=N` to filter the list; `/catalog/sports/:slug/tournaments` returns tournaments under a sport with live+upcoming match counts; `/catalog/matches/:id` returns all active (`status=1`) markets — provider-id whitelist removed. Odds formatted to 2 decimals via `formatOdds()`. List/count endpoints (`/catalog/matches`, `/catalog/sports/:slug`, `/catalog/sports/:slug/tournaments`, `/catalog/search`, `/catalog/live-counts`) gate on the shared `hasActiveMarket` predicate — at least one `markets.status=1` row AND `matches.status IN ('not_started','live')` — so matches with nothing to bet on (or that already went terminal) are dropped. The match-winner can be briefly suspended (mid-round, post-goal) while secondary markets stay active, and the row still surfaces. Defense in depth on the storefront side complements the upstream lifecycle fixes (terminal-status apply on `odds_change`, `bet_stop` blanket suspension, `bet_settlement certainty=2`); phantom-drain remains as the safety net for matches Oddin never sends a terminal signal for. Inline odds are additionally restricted to `variant='way:two'` (`isTwoWayMatchWinner`) so 1X2 sports like eFootball don't render misleading 1/2 buttons; the match still appears in the list and clicking through shows the full 1X2 on `/match/:id`. |
| Top-bar global search | Live | `/catalog/search?q=…` (case-insensitive, 6 hits per facet across active sports / tournaments / teams / matches; matches gated on at least one active market). Frontend popover in `top-bar-search.tsx` debounces 180 ms, supports arrow-key nav, Cmd/Ctrl+K focus, Esc/click-outside close. |
| Sidebar tournament sub-tree | Live | When the user is on `/sport/:slug`, the sidebar auto-fetches `/catalog/sports/:slug/tournaments` and renders an indented list under the sport. Each tournament links to `/sport/:slug?tournament=ID`; the sport page reads the param server-side and shows a dismissible filter chip. |
| Frontend design | Live (2026-04-18) | Ported from Claude Design handoff bundle. Grid shell: top-bar + left sidebar + main + right-rail bet slip. Route groups: `(auth)` = login/signup, `(main)` = home/sport/match/account/bets/wallet, `admin/*` keeps its own layout. Sidebar order: CS2 → Dota 2 → LoL → Valorant → every other active sport (alphabetical); `efootballbots` + `ebasketballbots` are hidden via both the feed-ingester blocklist (`BLOCKED_ODDIN_SPORT_SLUGS`) and a defensive filter in `sidebar.tsx`. Tokens in `apps/web/src/app/globals.css`; legacy `--color-*` aliases kept for admin/bets/wallet pages. |
| Bet slip + placement | Live | Singles + combos (up to 20 legs, cross-match only — same-match legs rejected server-side). Always-visible right rail (`apps/web/src/components/shell/bet-slip-rail.tsx`) drives the `BetSlipProvider` store, with a Single/Combo toggle and a USDT/OZ currency switcher (default OZ for the demo flow). The chosen currency is persisted in localStorage and forwarded as `currency` on `POST /bets`; the API debits the matching `(user_id, currency)` wallet. Withdrawals also block non-active users at request time. |
| bet-delay worker | Live | LISTEN + 1s sweep + 5% drift tolerance |
| Oddin AMQP feed (feed-ingester + settlement) | Live | AMQPS over `:5672` (not 5671), vhost `/oddinfeed/{customer_id}` URL-assembled by hand to preserve `%2F`. Bookmaker 142 |
| Recovery flow | Live | `POST /v1/{product}/recovery/initiate_request` triggered on every (re)connect for both producers + on `alive subscribed=0` + on `alive` timestamp drift > 5s. Admin `POST /admin/feed/recovery` rewinds the cursor and fires `feed_recovery` (AMQP replay only — `<sport_event_status>` rides on every odds_change so a replay is enough). When `flushOdds=true` (default, 2026-05-06), the route hard-deletes orphan markets and matches before the cursor rewind — every market on a not_started/live fixture with no `ticket_selections` and no `settlements` row is dropped (cascades to `market_outcomes`), then every match left without any markets is dropped (cascades to `feed_messages`). The `settlements` and `ticket_selections` FKs are RESTRICT, so money-attached rows physically can't be deleted — they fall through to the SUSPEND step (status=-1, null odds). Net effect: the active catalog is wiped to a clean slate and only what Oddin replays in the rewind window survives, while bet history and apply-once invariants stay intact. The phantom-drain (periodic REST refetch over stuck matches) was removed in PR #122: it was masking real Oddin issues by quietly mopping up rows the in-band signals failed to update. A match drifting out of sync is now a bug to investigate, not background noise. |
| `<sport_event_status>` is the lifecycle source of truth | Live (2026-05-06) | The Oddin spec (§2.4) lists exactly 8 message types: `fixture_change`, `odds_change`, `alive`, `bet_cancel`, `rollback_bet_cancel`, `bet_settlement`, `rollback_bet_settlement`, `snapshot_complete`. **Neither `match_status_change` nor `bet_stop` is in the protocol** — the integration broker for bookmaker 142 never emits them; our `handleMatchStatusChange` and `handleBetStop` handlers stay wired but only as a graceful no-op for any bookmaker that did emit them. The authoritative lifecycle signal is `<sport_event_status status="…"/>` carried inside every `odds_change` (per §2.4.1.2: documented values are `0` not_started, `1` live, `4` closed, `5` cancelled). `handleOddsChange` forwards every observed code through `store.UpdateMatchStatus`, whose SQL guard rejects regressions (terminal → anything else, anything → `not_started`). Net effect: a match appears on the live offer the first odds_change it ships with `status=1`, and drops off the offer the odds_change it ships with `status=4` or `5`. |
| All-markets-terminal close | Live (2026-05-06) | Per spec §2.4.2: "When a market or market line is settled with a bet_settlement message, it will be automatically removed from all subsequent match odds_change messages." So once the last market settles, no further odds_change arrives — a final `<sport_event_status status="4"/>` may never land. Settlement now calls `store.MarkMatchClosedIfAllMarketsTerminal(event_urn)` after every `bet_settlement` and every `bet_cancel`. The single SQL flips `matches.status='closed'` only when no market on the match is at `1 / 0 / -1 / -2` — so per-map market settlements during a live match (where the match-winner is still active) don't false-positive. Forward-only via the same status guard. |
| Phantom-drain ticker | **Removed** (2026-05-06, PR #122) | Was a 15-min REST sweep that mopped up matches whose `matches.status` never advanced. Removed because (a) `<sport_event_status>` inside every `odds_change` is the authoritative lifecycle signal post-PR #121, and (b) the drain was masking real Oddin / ingest bugs by silently overwriting rows whose in-band path had failed. A drifting match is now visible — debug it. |
| Live-stream embeds (Twitch / YouTube / Kick / Gjirafa) | Live (2026-05-06) | Oddin's `/v1/sports/{lang}/sport_events/{matchURN}/fixture` returns a `<tv_channels><tv_channel name=… language=… stream_url=…/></tv_channels>` block per the public schema. `oddinxml.FixtureTvChannelsList` parses it; resolver `merge()` JSON-encodes the rows into `matches.tv_channels` (migration 0022). Fixture `STREAM_URL` change_type 106 now also triggers `RefreshFromFixture` so the column tracks broadcaster swaps mid-event. `/catalog/matches/:id` classifies each entry into `{platform: twitch \| youtube \| kick \| gjirafa \| other, embedId, url, name, language}` and surfaces it as `match.streams`. The storefront `apps/web/src/components/match/match-streams.tsx` renders an iframe (Twitch via `https://player.twitch.tv/?channel=…&parent=<host>`, YouTube via `youtube-nocookie.com/embed/…`, Kick via `https://player.kick.com/<channel>`, Gjirafa via `https://video.gjirafa.com/embed/<slug>`) with a tab strip when there are multiple feeds. Anything that doesn't classify as embeddable is hidden (no outbound-link row) — only when the match has zero embeddable feeds at all does a single fallback card link out. The CSP `frame-src` (emitted by Next.js middleware in [`apps/web/src/middleware.ts`](./apps/web/src/middleware.ts), not Caddy) whitelists `https://player.twitch.tv https://www.twitch.tv https://www.youtube.com https://www.youtube-nocookie.com https://player.kick.com https://video.gjirafa.com`. |
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
| Admin: withdrawals approve flow | Live | `/admin/withdrawals` page with approve/reject/mark-submitted/confirmed/failed. **4-eyes (security audit PR #130)**: the actor that confirms must differ from the actor that approved (`approver_cannot_confirm` 403; DB-level CHECK as defence-in-depth). `tx_hash` validated per network (ERC20 `^0x[0-9a-fA-F]{64}$`, TRC20 `^(0x)?[0-9a-fA-F]{64}$` normalised to no-prefix), unique partial index on `(network, tx_hash)`. mark-confirmed pre-checks `balance >= debit`. Reject restricted to `requested` only (use mark-failed for already-approved rows); user-cancel and admin-reject / fail now write a `wallet_ledger` audit row (`adjustment` / `withdrawal_cancel` / `withdrawal_reject` / `withdrawal_fail`) for the lock release. |
| Admin: PnL dashboard | Live | `/admin` with KPIs (today PnL, active users, open tickets, stakes today), 14-day PnL × sport table, top-10 big wins (30d) |
| Admin: bettor user management | Live | `/admin/users` list + `/admin/users/[id]` edit (status/role/limit/bet-delay) with self-modification guards + audit logging. View pinned to `role=user` server-side via the API's new `roles` CSV filter; admins/support are hidden here. |
| Admin: admin user management | Live | `/admin/admins` list + create flow for backoffice operators (admin + support). Calls `/admin/users` with `?roles=admin,support`. Shared `CreateUserForm` is parameterized by `mode` — `admin` mode exposes role choice and drops bettor-only knobs (bet-delay + stake limit). |
| Admin: feed logs panel | Live | `/admin/logs` sport → tournament → match hierarchy (categories joined silently — esports auto-dummies). Per match: list of all markets with their outcomes + winner highlight (from `market_outcomes.result`), an inline 24h SVG chart, and a per-market **Odds history** button → `/admin/logs/matches/[id]/markets/[marketId]` with the full 7-day chronological table. **Feed log** button opens `/admin/logs/matches/[id]/feed` with a kind-filterable `<details>` viewer of raw AMQP XML. Counts and feed-message lookups join on `event_urn = matches.provider_urn` so rows inserted before the auto-mapper created the match (race condition) are still surfaced. feed-ingester writes every match-scoped kind to `feed_messages`; hourly `runFeedMessageCleanup` goroutine sweeps + backfills `match_id`. Uniform 7-day retention since `received_at`. |
| Admin: audit log viewer | Live | `/admin/audit` paginated with action/target/actor filters |
| Admin: FE Settings (markets display order) | Live | `/admin/fe-settings/markets-order` per-sport, per-scope editor with HTML5 drag-and-drop. Three scopes: `match` (markets without a `map` specifier), `map` (markets carrying a `map` specifier — one ordering shared across every Map N tab), `top` (curated highlights, empty by default). PUT `/admin/fe-settings/markets-order/:sportId/:scope` writes a transactional replace into `fe_market_display_order`. `/catalog/matches/:id` consults the table per request and sorts each scope group; when the `top` scope has rows, a synthetic "Top" group is prepended. List endpoints (`/catalog/sports/:slug`, `/catalog/matches`) also include `topMarket` per match so storefront list cards render a [Match \| Top] toggle inline (`apps/web/src/components/match/match-list-tabs.tsx`). |
| Admin: team logos | Live (2026-05-06) | `/admin/competitors` lists every team with sport/q/missing-logo filters, inline edit of `logo_url` / `brand_color` / `abbreviation`, and a per-row Clear button. Backed by [`services/api/src/modules/admin/competitors.ts`](./services/api/src/modules/admin/competitors.ts) (PATCH /admin/competitors/:id + audit logging). **Logos hot-link directly to Oddin's CDN** — Oddin is our authorised data partner and `cdn.oddin.gg` is built for this; no proxying, no docker volume, no file-server route. The single resolver, [`packages/db/src/resolve-logos.ts`](./packages/db/src/resolve-logos.ts), is one SQL UPDATE — copy `competitor_profiles.icon_path` (populated by feed-ingester from Oddin's `/v1/sports/{lang}/competitors/{urn}/profile` endpoint, ~1861/2135 profiles populated) onto `competitors.logo_url`. Idempotent; `pnpm --filter @oddzilla/db db:resolve-logos` runs in well under a second. Coverage on the current feed: ~87% of competitors have an `icon_path`; rows without one render the `TeamMark` initials fallback. Caddy CSP `img-src 'self' data: https:` accommodates the cross-origin `<img>`; `TeamMark` falls back to initials on `<img onError>` so a missing icon never breaks the layout. |
| Server security hardening | Live | Non-root inside every container (`node:1000` for TS, `app:100` for Go); `cap_drop: ALL` + `no-new-privileges:true` on every service in `docker-compose.yml`; Caddy keeps only `NET_BIND_SERVICE` (PR #130). Per-service `mem_limit` budgeted for the 4 GB CPX22 (postgres 1G, web 640M, api 512M, ws-gateway 256M, Go workers 320M, redis 320M, caddy 96M). Per-service `json-file` log rotation (10 MiB × 5 files) closes the disk-full repeat surface from `project_disk_full_incident`. SSH `PasswordAuthentication no`, `PermitRootLogin no`, `MaxAuthTries 3`, `X11Forwarding no`; repo dir `chmod 750`. **Nonce-based CSP** emitted by Next.js middleware (per-request nonce passed to the inline theme-boot script via `headers().get("x-csp-nonce")`); Caddy's static CSP removed. HSTS now has `preload`. `NODE_ENV=production` on server so auth cookies get `Secure` flag. `docker-compose.override.yml` renamed to `docker-compose.dev.yml` so a forgotten `-f` in production cannot auto-mount the source tree. `fail2ban` was installed briefly then removed (kept banning legit operator connections — password auth off makes brute force impossible anyway, see `project_security_hardening.md` memory). |
| Postgres backups | Live | `/usr/local/bin/oddzilla-pg-backup` (from `infra/hetzner/backup/pg_backup.sh`) runs daily at 03:00 UTC via root cron, `docker exec` into postgres container, writes `/var/backups/oddzilla/*.sql.gz` (root:root 600), 14-day rotation. PR #130 hardening: script no longer sources the entire `.env` into the cron shell (every secret was exported to `/proc/<pid>/environ`); reads only `POSTGRES_USER` / `POSTGRES_DB` / `POSTGRES_PASSWORD` / `BACKUP_GPG_RECIPIENT`. Setting `BACKUP_GPG_RECIPIENT` to an off-host operator's GPG key id encrypts each dump in addition to gzipping (extension becomes `.sql.gz.gpg`). **Off-server copy is still manual** — pre-launch todo. |
| Published odds margin | Active but **0 bp globally** | `odds_config` row `scope='global'` has `payback_margin_bp=0` because Oddin already ships odds with margin baked in. `applyMargin()` divides `raw / (1 + bp/10000)` with floor-truncate to 2 decimals. Admin `/admin/margins` still works for per-sport/tournament/market-type overrides when needed. |
| Wallet HD address derivation | Live | Done by the isolated [`services/signer`](./services/signer/) Go service. The API talks to it over a Unix socket on a tmpfs volume that only those two containers mount. The signer reads `HD_MASTER_MNEMONIC` once at boot and `os.Unsetenv`s it; no other process holds the secret. `cap_drop: ALL`, `no_new_privileges`, `read_only: true`, `mem_limit: 64m`. The API has no offline derivation fallback — `SIGNER_SOCKET_PATH` is required. Parity test pins ETH idx=0 to the canonical 0x9858EfFD232B4033E47d90003D41EC34EcaEda94 from the BIP44 abandon-mnemonic vector. |
| Wallet deposit scanners | Live, gated on RPC URLs | Boots idle if `TRON_RPC_URL` / `ETH_RPC_URL` absent. **Reorg-safe (PR #130)**: ETH scanner captures `blockHash` per Transfer log into `deposits.block_hash`; processor calls `Scanner.VerifyDeposit(dep)` before crediting (`eth_getBlockByNumber` lookup, compares hash). On divergence the row flips to `status='orphaned'` instead of crediting. ETH client also re-verifies log `Address` per row (defends against an RPC endpoint that ignores the address filter) and hard-errors on missing `0x` prefix in `Data` (the previous behaviour silently parsed as 0 and advanced the cursor — losing real Transfers). Tron `normalizeTronAddressOK` returns `(_, false)` on unrecognised shapes; scanner aborts the batch (cursor stays put) so a deposit cannot be quietly dropped. TRC20 `event_index` captured so multi-Transfer txs no longer collide on `(network, tx_hash, log_index=0)`. |
| Wallet withdrawal on-chain submission | **Manual** | Admin marks-submitted with tx hash from external signer/wallet. Pre-launch needs a dedicated signer container |
| News scraper | **Removed** | Service + `news_articles` table deleted via migration 0003; no longer in scope |
| Combos | Live | Frontend slip accumulates selections; Single/Combo toggle; settlement pays stake × product(EffectiveFactor), `bet_refund` ledger only when every leg voids. |
| Cash-out | Live | Migration 0015 adds `cashout_config`, `cashouts`, probability columns on `market_outcomes` / `odds_history` / `ticket_selections`, and a `cashout` value on `wallet_tx_type`. Algorithm is Sportradar §2.1.1 (`stake × ticketOdds × Π(legProb)`) with optional §2.1.2 deduction ladder; full-stake prematch window is configurable per-scope. Oddin already populates `probabilities="0.368"` on every active outcome (verified on the integration broker 2026-04-28); engine falls back to `1/oddsCurrent` when the attribute is missing. Endpoints: `GET /tickets/:id/cashout/quote`, `POST /tickets/:id/cashout`, plus `/admin/cashout-config` cascade. Frontend: [`apps/web/src/app/(main)/bets/cashout-panel.tsx`](./apps/web/src/app/(main)/bets/cashout-panel.tsx) polls every 2s and surfaces an accept dialog. Settlement is unaffected — `maybeSettleTicket` already gates on `t.Status == "accepted"`, so `cashed_out` tickets are never re-paid. |
| Community achievements + AI seed bettor PnL filter (Phase 10.4) | Live (2026-05-06) | Migration 0029 adds `achievement_definitions` + `user_achievements` (composite PK on `(user_id, achievement_id)` for idempotent unlocks). Five starter badges seeded inline: `first_win`, `combo_5`, `odds_20`, `payout_100x`, `streak_10`. Currency-agnostic predicates evaluated against `community_tickets` aggregates by [`EvaluateAchievements`](./services/settlement/internal/store/store.go) (Go) and [`evaluateAchievements`](./services/api/src/modules/community/achievements.ts) (TS), called immediately after every projection write — settle path, cashout path, admin backfill. `INSERT ... ON CONFLICT DO NOTHING` makes re-evaluation a no-op; rollback never revokes (achievements are facts about user history). Public profile API now returns the unlock list inline; storefront `/u/[nickname]` renders an Achievements grid with lucide icons. AI seed bettor accounts (`users.is_ai = true`) are now excluded from `/admin/stats/{kpis,pnl-by-day,big-wins}` per Decision D2 — their volume settles through real ledger rows but isn't real revenue. The bet generator (the actual placement loop) is a 10.4b follow-up. |
| Community scoring + Best Wins + Copy (Phase 10.3) | Live (2026-05-06) | Score formula written into the projection upsert SQL, frozen at settlement time. Components: Inspiration 25 (`log10(payout/stake)`, capped, only on wins), Odds 15 (`log(total_odds)/log(20)`, capped), Reputation 15 (user's prior win-rate in this currency from `community_tickets`, snapshot at `settled_at`), Copyability 15 (reserved for 10.4, 0 today). Recency (30 pts) is applied at QUERY time — `?sort=best` filters `settled_at >= now() - interval '7 days'` and uses the existing `(score DESC, settled_at DESC)` index. The stored score is time-invariant; no cron recompute needed. `GET /community/feed?sort=best` powered by the same endpoint as recent. `POST /community/copy/:communityTicketId` returns a slip-ready selection list (matchId/marketId/outcomeId/odds + display labels + sportSlug + per-leg `available` flag); the web client adds them to the existing bet-slip via [`useBetSlip().add()`](./apps/web/src/lib/bet-slip.tsx) and opens the rail for confirmation. POST /bets re-validates everything at placement, so drift between copy-click and confirm surfaces there. UI: Recent / Best Wins tab strip on `/community`; Copy this bet button on every `CommunityTicketCard`. |
| Community feed + projection (Phase 10.2) | Live (2026-05-06) | Migration 0025 adds `community_tickets`, a denormalised read-model of publicly-resolved tickets. `services/settlement` writes the projection inside `SettleTicket` / `ReverseSettledTicket` via [`WriteCommunityProjection`](./services/settlement/internal/store/store.go); cashout writes inline (TS, [`writeCommunityProjection`](./services/api/src/modules/community/projection.ts)). Both paths share the same upsert SQL (apply-once on `ticket_id UNIQUE` + `ON CONFLICT DO UPDATE`). Public surface: `GET /community/feed?currency=&sport=&page=&pageSize=` (recent-first, anonymous, filters out `tickets_public=false` users), `GET /community/users/:nickname/tickets` (per-user history). Storefront: [`/community`](./apps/web/src/app/(main)/community/page.tsx) page with sport + currency filter pills and [`CommunityTicketCard`](./apps/web/src/components/community/ticket-card.tsx); recent tickets now render on `/u/[nickname]`. Sidebar: top-level "Community" entry → /community (was previously aliased to settings). Profile stats refactored to aggregate from `community_tickets` (settled / wins / win rate / ROI per currency). Admin recovery: `POST /admin/community/backfill` sweeps any miss in 500-row batches; idempotent. |
| Community profiles + visibility (Phase 10.1) | Live (2026-05-06) | Migration 0024 adds `users.tickets_public BOOL DEFAULT TRUE` (Decision D1: max feed density on day one), `users.nickname citext UNIQUE`, `users.bio TEXT` (≤280 char DB-side cap), `users.is_ai BOOL DEFAULT FALSE` (Decision D2: never serialised). API module [`services/api/src/modules/community/routes.ts`](./services/api/src/modules/community/routes.ts) exposes `GET /community/users/:nickname/profile?currency=USDT|OZ` (anonymous; per-currency stats placeholder pending Phase 10.2 projection), `GET /community/me` (authed), `PATCH /community/me/visibility`, `PATCH /community/me/profile`. Storefront pages: `/u/[nickname]` ([`apps/web/src/app/(main)/u/[nickname]/page.tsx`](./apps/web/src/app/(main)/u/[nickname]/page.tsx)) public profile with USDT/OZ tab toggle (Decision D4); `/account/community` ([`apps/web/src/app/(main)/account/community/page.tsx`](./apps/web/src/app/(main)/account/community/page.tsx)) for nickname / bio / visibility. Sidebar gains a "Community" entry under Account. Phase 10.2 (feed + projection) is the next stage — see [`docs/COMMUNITY_PLAN.md`](./docs/COMMUNITY_PLAN.md). |
| Security audit (6-PR pass) | Live (2026-05-06, PR #130) | All Critical + High + selected Medium findings from the full-project audit landed in one merge: 4-eyes withdrawal flow, tamper-evident audit log (SHA-256 hash chain via BEFORE INSERT trigger + `admin_audit_chain_check()` verifier), reorg-safe deposit credits, ETH/Tron scanner hardening, refresh-token family + replay detection, per-request session-revocation cache, JWT audience claim, Origin-based CSRF plugin, login-timing equalisation, argon2id bumped to 2026 OWASP minimum, password change rate-limited + immediate other-device session kill, web container decoupled from `JWT_SECRET`, nonce-based CSP, javascript: URL filter on Oddin streams, status-code allow-list `{0,1,4,5}`, REST body cap (`http.MaxBytesReader`), name length cap on auto-mapper, container `cap_drop` + `no-new-privileges` + `mem_limit` + log rotation, encrypted backup option, settlement payload-hash canonicalisation (drops raw bytes — closes whitespace-replay duplicate-payout path), cashout drift floor in bigint (was 32-bit truncating for stakes > ~2147 USDT), bulk-logos `eq()` instead of `ilike()`, `/admin/feed/recovery` rate-limited 3/hr, admin-self-edit guard extended to `globalLimitMicro` + `betDelaySeconds`, typed errors in admin config (no more 500-on-validation-failure). See PR description for the full list. |
| Multi-currency wallets (USDT + OZ demo) | Live (2026-04-29) | Migration 0014: composite PK `wallets(user_id, currency)`, `currency CHAR(4) NOT NULL DEFAULT 'USDT'` on `wallet_ledger` and `tickets`. Currencies hard-coded in [`packages/types/src/currencies.ts`](./packages/types/src/currencies.ts). Signup creates a USDT wallet (zero) + OZ wallet (1000 OZ bonus) atomically with an `(adjustment, signup_bonus, user_id)` audit ledger row. `GET /wallet` returns `{ wallets: WalletSnapshot[] }`. `POST /bets` accepts `currency`, debits the matching wallet. Settlement Go scopes wallet/ledger ops by currency from `tickets.currency`. Bet-slip UI has a USDT/OZ tab switcher (default OZ, persisted in localStorage); top-bar shows the active currency's balance, replaces `+ Deposit` with a `Demo` chip when OZ is active. Withdrawals + deposits remain USDT-only — backfill SQL for existing users is in [`docs/OPERATIONS.md`](./docs/OPERATIONS.md#oz-demo-currency-backfill). |
| Oddin Disir widgets (prematch + live) | Live (2026-05-06) | Server-side proxy at `/widgets/*` ([`services/api/src/modules/widgets/routes.ts`](./services/api/src/modules/widgets/routes.ts)) holds the `x-brand-token`, calls Disir's REST per the December 2025 integration doc (`HumanDocs/Oddin.gg Disir - Widgets documentation.docx`), and returns `{url}` for the storefront iframe `src`. Three endpoints: prematch-match, prematch-tournament, live-scoreboard. URLs are 120s Redis-cached so 50 simultaneous viewers hit Disir once. Frontend wraps every iframe in [`DisirWidget`](./apps/web/src/components/widgets/disir-widget.tsx) which subscribes to the doc-defined postMessage events (`LOADED`/`RESIZE`/`DATA`/`CLOSE`/`SCROLL_TOP`) — `RESIZE.height` drives `iframe.style.height`, live widgets stay `display:none` until `DATA: {available: true}` arrives. **Desktop layout**: prematch widget mounts inside the right rail aside (`oz-rail-prematch`) below the bet slip via [`MatchPageContext`](./apps/web/src/lib/match-page-context.tsx); live scoreboard sits below the Twitch / YouTube embed inside [`MatchLiveMedia`](./apps/web/src/components/widgets/match-live-media.tsx). **Mobile (≤1099px)**: rail-embedded prematch hidden; the match page renders [`MatchPrematchMobile`](./apps/web/src/components/widgets/match-prematch-mobile.tsx) (collapsed toggle button under the match info, expands to a full-width iframe above the markets). Live media swaps to a Stream/Stats pill toggle. Sport gating in [`supported-sports.ts`](./apps/web/src/components/widgets/supported-sports.ts) — prematch covers cs2/dota2/lol/valorant/efootball, live covers those + ebasketball/ecricket. CSP `frame-src` whitelists `https://*.oddin.gg`. Domain-whitelisting is a manual step on Oddin's side: every host that embeds a widget must be emailed to `support@oddin.gg` (currently `oddzilla.cc`). |
| Oddin BetBuilder (OBB) — same-match combos | Live (2026-05-07) | Migration 0031 extends `bet_type` with `'betbuilder'`. New `services/api/src/modules/betbuilder/routes.ts` proxies Oddin's gRPC: `GET /betbuilder/match/:id/markets` (eligibility) and `POST /betbuilder/match/:id/quote` (SessionCreate → combined session odds + still-available markets). gRPC client at [`services/api/src/lib/obb-client.ts`](./services/api/src/lib/obb-client.ts) — vendored proto under [`services/api/proto/obb/`](./services/api/proto/obb/). Frontend: a manual toggle on the match page ([`apps/web/src/components/match/betbuilder-toggle.tsx`](./apps/web/src/components/match/betbuilder-toggle.tsx)) flips the slip into `mode: "betbuilder"` for that match — `add()` then accepts multiple legs from the same match (default same-match replace is bypassed). Slip rail re-quotes on every leg change and submits `POST /bets` with `betType="betbuilder"` + `betBuilder: {sessionId, expectedOddsX10000, selectionIds}`. Server calls `SessionInfo` to revalidate before debiting; on `invalid` the placement 400s `betbuilder_session_invalid` and the slip refreshes. Settlement path ([`BetBuilderPayout` in payout.go](./services/settlement/internal/settler/payout.go)): all-won → `stake × oddsX10000/10_000` (bet_payout); any leg lost → 0 (bet_payout); any leg voided + non-loss rest → refund stake (bet_refund) since OBB combined odds aren't a product and we can't recompute on partial voids. bet-delay branches on `bet_type='betbuilder'` to skip per-leg drift (the Oddin session combined odds are non-multiplicative; per-leg drift is a meaningless tripwire), but still enforces market + outcome activity. Sport gating mirrors OBB doc Appendix #1 (CS2 / CS2 Duels / Valorant / eFootball / eBasketball). **Disabled until env populated**: `ODDIN_OBB_HOST` empty → `/betbuilder/*` 503s `betbuilder_disabled`, toggle hides on the match page, placement of `betType="betbuilder"` is rejected upfront — same graceful-idle pattern Disir uses. Token defaults to `ODDIN_TOKEN` (Oddin issues a single per-customer token; override with `ODDIN_OBB_TOKEN` only if they cut a separate one). IP allowlist: every environment that calls OBB must be whitelisted via Oddin's dedicated channel before flipping `ODDIN_OBB_HOST` on. |
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
- `FRONTEND_HOST=oddzilla.cc`, `ADMIN_HOST=sadmin.oddzilla.cc`, `ACME_EMAIL=alexander.chernavin@oddin.gg` — consumed by Caddy for per-host reverse-proxy + Let's Encrypt. The Caddyfile also serves a hard-coded 301 from the legacy `s.oddzilla.cc` to the apex.
- `COOKIE_DOMAIN=.oddzilla.cc` — shared cookie across the apex + admin subdomain
- `CORS_ORIGINS=https://oddzilla.cc,https://sadmin.oddzilla.cc`
- `NEXT_PUBLIC_API_URL=` and `NEXT_PUBLIC_WS_URL=` — **both empty on prod**. Browser falls back to `/api` and `wss://<host>/ws` via Caddy. Non-empty values bake `http://localhost:3001` into the prod bundle and break in-browser auth. For local `pnpm dev`, put non-empty values in `apps/web/.env.local`.
- `HD_MASTER_MNEMONIC=` **empty** — withdrawal/deposit features inert until set. Generate any BIP39 phrase.
- `TRON_RPC_URL` defaults to `https://api.trongrid.io`
- `ETH_RPC_URL=` **empty** — ERC20 scanner inert until provided
- `BACKUP_GPG_RECIPIENT=` (optional) — set to an off-host operator's GPG key id and the daily pg dump is encrypted in addition to gzipped (`.sql.gz.gpg`). Leave unset to keep the gzip-only behaviour.
- `DISIR_BRAND_TOKEN=` Oddin Disir widget brand token. Held only by the api process; the frontend never sees it. When empty the `/widgets/*` routes 503 `widget_disabled` and the storefront silently skips rendering the iframes. Per-environment — request a separate token for `integration` vs `main`.
- `DISIR_BASE_URL=https://api-disir.oddin.gg` (optional override for staging endpoints).
- `DISIR_ENV=integration|main` — written into the upstream URL path (`/statistics/{env}/match/...`). Stays at `integration` until we cut over the entire stack to Oddin production. **Note:** every domain hosting a widget iframe must be whitelisted by Oddin support — currently `oddzilla.cc` (post-migration; the old `s.oddzilla.cc` is still on the allowlist while it 301s) plus any dev hosts you add via `pnpm dev`. Email `support@oddin.gg` with the host list when adding a new environment.
- `ODDIN_OBB_HOST=` Oddin BetBuilder gRPC endpoint (e.g. `api-obb.integration.oddin.gg:443` for integration, `api-obb.oddin.gg:443` for prod). Empty = `/betbuilder/*` 503s and the storefront toggle hides. **IP allowlist required**: each calling environment must be whitelisted on Oddin's side before flipping this on. `ODDIN_OBB_TLS=true` (default) for both integration and prod. Token resolves from `ODDIN_OBB_TOKEN` first, then `ODDIN_TOKEN` — Oddin currently issues a single per-customer token usable for both feed + OBB.

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

All should be silent / green. Last known good state: end of the security
audit pass (PR #130, 2026-05-06) — see [`docs/PHASES.md`](./docs/PHASES.md)
for the commit-by-commit changelog.

**Audit-log integrity probe** — to confirm no row in `admin_audit_log`
has been tampered with after insert:

```sh
ssh team@178.104.174.24 'set -a; . /home/team/oddzilla/.env; set +a; sudo -n docker exec oddzilla-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT COUNT(*) FILTER (WHERE ok) AS valid, COUNT(*) FILTER (WHERE NOT ok) AS broken, COUNT(*) AS total FROM admin_audit_chain_check();"'
```

`broken` should always be `0`. Any non-zero value is the canonical
"someone edited the audit log via direct DB access" signal.

For the production server, after a `git push` to main:

```bash
# 1. Fast-forward the worktree on the box.
ssh team@178.104.174.24 "cd /home/team/oddzilla && \
  git fetch origin main && git reset --hard origin/main"

# 2. Run migrations FIRST (drizzle migrations are safe under the
#    running images — every column added so far has been nullable).
#    DATABASE_URL points at host `postgres` for in-container access;
#    swap it to 127.0.0.1 because the migrate runner is on the host.
ssh team@178.104.174.24 "set -a; . /home/team/oddzilla/.env; set +a; \
  export DATABASE_URL=\$(echo \"\$DATABASE_URL\" | sed 's|@postgres:|@127.0.0.1:|'); \
  pnpm --filter @oddzilla/db db:migrate"

# 3. Build ONLY the services this PR changed, ONE AT A TIME, then
#    recreate just those. NEVER run `docker compose build` (no
#    service argument) on this box.
for svc in api web feed-ingester; do
  ssh team@178.104.174.24 "cd /home/team/oddzilla && \
    sudo -n docker compose -f docker-compose.yml build $svc"
done
ssh team@178.104.174.24 "cd /home/team/oddzilla && \
  sudo -n docker compose -f docker-compose.yml up -d --no-deps --force-recreate api web feed-ingester"
```

> **DO NOT run `docker compose build` without a service argument on
> this box.** CPX22 has 4 GB RAM — building all 7 services in
> parallel exhausts memory, drives the kernel into swap thrash
> (CPU pegged at 200%, disk reads sustained at ~1 GB/s), and SSH
> banner exchange starts timing out. The site goes dark until
> someone power-cycles the VM via the Hetzner console. The serial
> per-service form above stays well under the RAM ceiling.
>
> Migration → build → recreate is the right order. The new column
> appears before the new code reads it; running images can ignore
> a nullable column they don't know about. Use `--no-deps` so
> dependency services (postgres, redis, caddy, …) keep running
> across the rollout.
>
> SSH+`sg docker` is also a trap (`$`-escaping, see the
> `project_ssh_dollar_escaping` memory) — `sudo -n docker compose`
> is the safe form.

## Handoff notes for the next session

If you're a fresh agent picking this up:

1. **Read this file first** (you're here). Then skim
   [`docs/PHASES.md`](./docs/PHASES.md) for what's done and what's next.
2. **All phases 1–8, Phase 10 (community), the post-Phase-8 hardening,
   AND the security audit pass (PR #130) are live and deployed.**
   The news scraper was cancelled mid-Phase-8 (migration 0003 dropped
   the table; `services/news-scraper/` is gone). The next layer of work
   is the **pre-launch exit gates** — KYC, signer isolation, daily
   wallet reconciliation, off-host encrypted backups (the script now
   supports `BACKUP_GPG_RECIPIENT`; the rsync target is still manual),
   runbook, monitoring. These are blockers for accepting real user
   traffic, not for further dev work.
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
   `curl -s https://oddzilla.cc/_next/static/chunks/... | grep localhost:3001`
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
