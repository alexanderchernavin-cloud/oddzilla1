# Oddzilla

B2C esports sportsbook MVP. Oddin.gg integration on the **protocol level**
(raw AMQP + REST, no SDK). CS2, DOTA2, LOL, Valorant with Match Winner and
Map Winner markets. USDT-only (TRC20 + ERC20) payments. Minimalist dark
Gen Z aesthetic.

## Quick start

```bash
cp .env.example .env           # fill in real values for prod
make up                        # brings up postgres, redis, caddy, all services
make migrate                   # applies SQL migrations
make seed                      # idempotent: sports, dummy categories, admin
```

Running services after `make up`:

| URL | Purpose |
| --- | --- |
| http://localhost:3000 | Next.js frontend ([apps/web](apps/web/)) |
| http://localhost:3001/healthz | REST API ([services/api](services/api/)) |
| http://localhost:3002/healthz | WebSocket gateway ([services/ws-gateway](services/ws-gateway/)) |
| http://localhost:8081..8085/healthz | Go services |
| http://localhost | Caddy reverse proxy (prod) |

Seeded credentials (override via `.env` before `make seed`):
- **Admin:** `admin@oddzilla.local` / `ChangeMeAdmin123!`
- **User:** `user@oddzilla.local` / `ChangeMeUser123!`

## Documentation

Start with [**CLAUDE.md**](CLAUDE.md) for the architecture summary and
invariants — it's the load-bearing doc for both humans and agents.

Deeper references live in [**`docs/`**](docs/):

| Doc | Use when you need to know... |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How services fit together. End-to-end walkthroughs for odds updates, bet placement, settlement, deposits. Scale path. |
| [SCHEMA.md](docs/SCHEMA.md) | Why each table exists, key constraints, common queries. |
| [ODDIN.md](docs/ODDIN.md) | Oddin AMQP routing keys, XML shapes, REST endpoints, market IDs, gotchas. |
| [PHASES.md](docs/PHASES.md) | Phase-by-phase roadmap, acceptance bars, post-MVP candidates, exit gates. |
| [OPERATIONS.md](docs/OPERATIONS.md) | Deploy, backup, incident playbook. |

Each service has its own local README:

- [services/api](services/api/README.md)
- [services/ws-gateway](services/ws-gateway/README.md)
- [services/feed-ingester](services/feed-ingester/README.md)
- [services/odds-publisher](services/odds-publisher/README.md)
- [services/settlement](services/settlement/README.md)
- [services/bet-delay](services/bet-delay/README.md)
- [services/wallet-watcher](services/wallet-watcher/README.md)
- [services/news-scraper](services/news-scraper/README.md)
- [apps/web](apps/web/README.md)
- [packages/db](packages/db/README.md)
- [packages/types](packages/types/README.md)
- [packages/auth](packages/auth/README.md)
- [packages/config](packages/config/README.md)

Server access (Hetzner CPX22): [CONNECT.md](CONNECT.md).

## Repository layout

```
apps/web/            Next.js 16 App Router (Tailwind v4, dark theme)
services/
  api/               TS Fastify REST API
  ws-gateway/        TS WebSocket fanout
  feed-ingester/     Go — Oddin AMQP consumer
  odds-publisher/    Go — applies payback margin, publishes pub/sub
  settlement/        Go — settle/cancel/rollback with apply-once semantics
  bet-delay/         Go — finalizes pending_delay tickets
  wallet-watcher/    Go — Tron + Ethereum USDT deposits
  news-scraper/      TS cron
packages/
  db/                Drizzle schema + SQL migrations
  types/             Shared API + WS + money + specifier helpers
  auth/              argon2id + JWT
  config/            zod env parsing
  tsconfig/          tsconfig presets
  eslint-config/     shared ESLint config
infra/
  hetzner/           bootstrap.sh for the production box
docs/                ARCHITECTURE, SCHEMA, ODDIN, PHASES, OPERATIONS
```

## Development

```bash
pnpm install                   # install TS deps
make up                        # postgres + redis + services
pnpm dev                       # TS services + Next.js in watch mode
# Go services run in Docker by default; to iterate locally:
cd services/feed-ingester && go run ./cmd/feed-ingester
```

Useful Make targets:

```
make up        start compose stack
make down      stop
make logs      tail all service logs
make migrate   apply database migrations
make seed      insert sports + admin + test user
make psql      open psql on the running postgres
make fmt       prettier + gofmt
make lint      pnpm lint + go vet (per service)
make nuke      DESTROYS volumes (local only)
```

## Architecture invariants

These are the rules every service must follow. Documented in detail in
[CLAUDE.md](CLAUDE.md); summary:

- **Money is `BIGINT micro_usdt`.** 1 USDT = 1,000,000 micro. Never `float`,
  `NUMERIC`, or `number`.
- **Drizzle is the schema source of truth.** Go services read those
  tables via hand-written `pgx` queries in their `internal/store/`.
- **Specifier canonicalization.** Sorted `k=v|k=v`, sha256 →
  `specifiers_hash`. Go and TS implementations must match byte-for-byte.
- **Apply-once settlement.** Unique
  `(event_urn, market_id, specifiers_hash, type, payload_hash)` on
  `settlements`.
- **Apply-once wallet credits.** Unique
  `(type, ref_type, ref_id) WHERE ref_id IS NOT NULL` on `wallet_ledger`.
- **No localhost in code.** All hostnames come from env.
- **No emojis anywhere.** UI, logs, commits.

## Current phase

**Phases 1–7 complete** — scaffold, auth, feed ingester, live odds
pipeline, bet slip + placement + bet-delay, settlement worker, and
USDT wallet (TRC20 + ERC20 deposit scanner + withdrawal request/admin
flow + HD address derivation).

Next: Phase 8 — admin dashboard PnL + news scraper. See
[docs/PHASES.md](docs/PHASES.md) for the full roadmap.

## License

Proprietary. All rights reserved.
