# @oddzilla/db

Single source of truth for the Postgres schema. Drizzle ORM schema in
`src/schema/`, hand-written SQL migrations in `migrations/`, idempotent
seed in `src/seed.ts`.

For the reasoning behind each table see [`../../docs/SCHEMA.md`](../../docs/SCHEMA.md).

## Commands

```bash
pnpm db:migrate     # apply new SQL files in migrations/ transactionally
pnpm db:seed        # insert sports, dummy categories, admin + test users
pnpm db:studio      # Drizzle Studio UI at localhost
pnpm db:check       # drizzle-kit schema drift check vs live DB
```

From the repo root: `make migrate` and `make seed`.

## Adding a migration

1. Edit `src/schema/<file>.ts` — add/modify the Drizzle table.
2. Write equivalent SQL in `migrations/<next>_<desc>.sql`.
3. Append an entry to `migrations/meta/_journal.json`.
4. `make migrate` applies it and records the filename in `_migrations`.

We don't use `drizzle-kit migrate` because our schema needs Postgres
features (partitioning, extensions) that Drizzle can't emit. Drizzle is for
typed TS queries; SQL files are runtime truth.

## Migrations applied

| File | What |
| --- | --- |
| `0000_init.sql` | All domain tables + enums + indexes |
| `0001_odds_history_partitions.sql` | pg_partman daily partitioning for `odds_history` |
| `0002_chain_scanner_state.sql` | Per-chain block cursor for wallet-watcher |

## Go consumption

The original plan was to add `sqlc` per Go service to generate typed query
code from the same migration SQL. We didn't adopt it — the per-service
query surface is small enough that hand-written `pgx.Pool.Exec`/`QueryRow`
calls (in each service's `internal/store/`) are clearer than codegen.
Schema still moves in lockstep with Drizzle because every change starts
in `src/schema/*.ts` + a SQL migration; the Go services just read the
tables those produce.

## Apply-once constraints (don't remove without reading)

- `wallet_ledger (type, ref_type, ref_id) WHERE ref_id IS NOT NULL` —
  prevents duplicate credits.
- `settlements (event_urn, market_id, specifiers_hash, type, payload_hash)` —
  prevents replaying Oddin settlement messages.
- `deposits (network, tx_hash, log_index)` — prevents counting one on-chain
  Transfer twice.
- `tickets.idempotency_key` — lets clients safely retry POST /bets.

See [`CLAUDE.md`](../../CLAUDE.md) invariants.
