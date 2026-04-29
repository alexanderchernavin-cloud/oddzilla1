# Database schema reference

Canonical SQL lives in [`../packages/db/migrations/`](../packages/db/migrations/):

- `0000_init.sql` — every domain table.
- `0001_odds_history_partitions.sql` — pg_partman setup for `odds_history`.
- `0002_chain_scanner_state.sql` — block cursor for `wallet-watcher`.
- `0003_drop_news_articles.sql` — drops the news_articles table after the
  news scraper was cancelled mid-Phase-8.
- `0004` – `0013` — sport seed cleanup, market descriptions, competitor
  profiles, odds-config global-uniqueness fix, feed-messages audit,
  tournament risk-tier ranking. See file names for detail.
- `0014_multi_currency.sql` — composite `(user_id, currency)` PK on
  `wallets`; `currency CHAR(4)` column on `wallet_ledger` and `tickets`.
  Adds the demo `OZ` currency alongside USDT (every signup gets a 1000
  OZ bonus written through the ledger so the bet flow is testable
  without on-chain top-up).
- `0015_cashout.sql` — probability columns on `market_outcomes` /
  `odds_history` / `ticket_selections`; `cashout` value on
  `wallet_tx_type`; `cashout_config` cascade table; `cashouts`
  quote/accept records; `cashout_status` enum.
- `0016_cashout_acceptance_delay.sql` — `cashout_config.
  acceptance_delay_seconds` (default 5; 0–60 range).
- `0017_tiple_tippot.sql` — `tiple` / `tippot` values on `bet_type`;
  `bet_meta` JSONB on `tickets`; `bet_product_config` per-scope pricing.
- `0018_bet_product_per_leg_margin.sql` — `bet_product_config.margin_bp_per_leg`;
  effective margin used at placement is `margin_bp + margin_bp_per_leg × N`,
  giving Tippot the same per-leg compounding a combo gets via its odds
  product. Tippot defaults to 0 + 500 (5% × N); Tiple stays at 1500 + 0.

Drizzle mirror is [`../packages/db/src/schema/`](../packages/db/src/schema/).

This doc explains **why** each table exists and which invariants it enforces.
For column-by-column detail open the SQL file — it's concise and annotated.

## Conventions

- **Money** is `BIGINT` with 6-decimal precision (1 unit = 1,000,000 micro).
  Suffix `_micro`. The amount is per-currency — every wallet/ledger/ticket
  row also carries a `currency CHAR(4)` column.
- **Currencies** (migration 0014):
  - `USDT` — real money on TRC20/ERC20. Decimals match on-chain USDT.
  - `OZ` — demo currency for testing the bet flow without on-chain top-up.
    Every signup gets a 1000 OZ bonus written through the ledger. Deposits
    and withdrawals stay USDT-only — there is no on-chain network for OZ.
  - The list is hardcoded in [`packages/types/src/currencies.ts`](../packages/types/src/currencies.ts)
    as `SUPPORTED_CURRENCIES`. No DB enum — `CHAR(4)` keeps it cheap to
    extend.
- **Time** is `TIMESTAMPTZ`. Always UTC.
- **Enums** are first-class Postgres enum types (see top of `0000_init.sql`).
- **UUIDs** for user-facing / externally-referenced rows. `SERIAL` / `BIGSERIAL`
  for internal-only tables and high-volume append tables.
- **Soft deletion is avoided.** We use `status` columns or `revoked_at`
  timestamps where lifecycle states matter.
- **Indexes are partial wherever possible** to keep them small and hot paths
  fast.

## Enums (quick reference)

| Enum | Values |
| --- | --- |
| `user_status` | `active`, `blocked`, `pending_kyc` |
| `user_role` | `user`, `admin`, `support` |
| `kyc_status` | `none`, `pending`, `approved`, `rejected` |
| `wallet_tx_type` | `deposit`, `withdrawal`, `bet_stake`, `bet_payout`, `bet_refund`, `adjustment`, `cashout` |
| `chain_network` | `TRC20`, `ERC20` |
| `deposit_status` | `seen`, `confirming`, `credited`, `orphaned` |
| `withdrawal_status` | `requested`, `approved`, `submitted`, `confirmed`, `failed`, `cancelled` |
| `sport_kind` | `esport`, `traditional` |
| `match_status` | `not_started`, `live`, `closed`, `cancelled`, `suspended` |
| `outcome_result` | `won`, `lost`, `void`, `half_won`, `half_lost` |
| `ticket_status` | `pending_delay`, `accepted`, `rejected`, `settled`, `voided`, `cashed_out` |
| `bet_type` | `single`, `combo`, `system`, `tiple`, `tippot` |
| `settlement_type` | `settle`, `cancel`, `rollback_settle`, `rollback_cancel` |
| `odds_scope` | `global`, `sport`, `tournament`, `market_type` |
| `mapping_status` | `pending`, `approved`, `rejected` |
| `cashout_status` | `offered`, `accepted`, `declined`, `expired`, `errored`, `unavailable` |

## Table groups

### Identity

**`users`** — the root of everything. Email is `CITEXT UNIQUE`; password is an
argon2id encoded string. `global_limit_micro = 0` means no per-user cap (admin
can set any positive value). `bet_delay_seconds` is 0–300; non-zero enables
the bet-delay worker for this user's tickets. `status='blocked'` freezes all
bet placement + deposits + withdrawals. `role` gates admin UI access.

**`sessions`** — refresh-token records. We store SHA-256 of the opaque refresh
token; the raw token only ever lives in the user's httpOnly cookie. Rotation
on each refresh sets `revoked_at` on the old row and creates a new one. The
partial index `WHERE revoked_at IS NULL` makes active-session lookups cheap.

### Wallet

**`wallets`** — one row per `(user_id, currency)`. Composite primary key
since migration 0014 — every user has both a USDT wallet (real money,
zero on signup) and an OZ wallet (demo money, 1000 OZ on signup).
`balance_micro` = total. `locked_micro` = locked by open tickets.
`balance_micro - locked_micro` = spendable. A table check enforces
`balance_micro >= locked_micro`.

> **Currency scoping rule.** Every wallet read/write that previously
> filtered on `user_id` alone now also filters on `currency`. Forgetting
> the currency clause silently picks the alphabetically first row
> (CAS for "OZ" before "USDT" if both have OZ first). All callers in
> the codebase (`bets/service.ts`, `admin/withdrawals.ts`,
> `admin/tickets.ts`, settlement Go store, bet-delay Go store) are
> already updated. Withdrawals and on-chain deposits hard-code
> `currency='USDT'` because there is no OZ chain.

**`wallet_ledger`** — append-only audit log. Every credit / debit produces
a row here with signed `delta_micro`, the `currency` it moved, `type`,
`ref_type`/`ref_id` pointing back to the cause (ticket UUID, deposit UUID,
withdrawal UUID), and optional `tx_hash` for on-chain events. The
signup OZ bonus shows up as
`(adjustment, signup_bonus, user_id, +1_000_000_000)` and is keyed off
the unique partial index so it can never double-credit on retry.

> **Apply-once invariant.** `UNIQUE (type, ref_type, ref_id) WHERE ref_id IS
> NOT NULL`. Any attempt to re-credit a deposit, re-pay a ticket, or re-refund
> a cancel is a duplicate-key error and rolls the transaction back. This is
> the last line of defense; every writer also does its own de-duping above.

**Wallet movement model.** Important nuance: `wallet_ledger` does NOT
satisfy "sum(ledger) = balance". The placement of a bet writes a
`bet_stake` row with `delta=-stake` but balance doesn't drop yet — only
`locked_micro` increases. The full flow per ticket lifecycle:

| Event | wallets.balance | wallets.locked | wallet_ledger row |
| --- | --- | --- | --- |
| Placement | unchanged | +stake | `(bet_stake, ticket, ticketId, -stake)` |
| bet-delay accept | unchanged | unchanged | (none) |
| bet-delay reject | unchanged | -stake | `(bet_refund, ticket, ticketId, +stake)` |
| Settle won | +(payout-stake) | -stake | `(bet_payout, ticket, ticketId, +payout)` |
| Settle lost | -stake | -stake | (none — the -stake from placement is the final entry) |
| Settle void | unchanged | -stake | `(bet_refund, ticket, ticketId, +stake)` |
| Rollback prior win | -(payout-stake) | +stake | `(adjustment, ticket, <latest payout ref_id>, -payout)` |
| Manual void (admin) | unchanged | -stake | `(bet_refund, ticket, ticketId, +stake)` |
| Cashout accepted | +(offer-stake) | -stake | `(cashout, ticket, ticketId, +(offer-stake))` |
| Deposit credited | +amount | unchanged | `(deposit, deposit, depositId, +amount)` |
| Withdrawal requested | unchanged | +amount | (none — lock only) |
| Withdrawal cancelled / rejected / failed | unchanged | -amount | (none — release only) |
| Withdrawal confirmed | -(amount+fee) | -amount | `(withdrawal, withdrawal, withdrawalId, -(amount+fee))` |

The `(type, ref_type, ref_id)` unique partial index distinguishes
`bet_payout` from `adjustment` so a rollback can coexist with the
original payout row in the audit trail.

**Generation suffix on `ref_id` (re-settle support).** When Oddin sends
`settle → rollback → re-settle` with a different result for the same
ticket, the second `bet_payout` would have collided with the first on
the partial unique index and been silently dropped. The settlement
worker now suffixes `ref_id` with `:N` (generation number) on the
second and later settles for the same ticket, and the matching rollback
adjustment row reuses that suffix so audit pairs stay clean. The
`bet_stake` row is always plain `ticketId` (one stake per ticket). See
`nextPayoutRefID` and `LatestUnreversedPayoutRefID` in
`services/settlement/internal/store/store.go`. Reconciliation queries
that look for "all ledger rows for ticket T" should match
`ref_id = ticketId OR ref_id LIKE ticketId || ':%'`.

**`deposit_addresses`** — one (user, network) pair per row, unique on both
`(user_id, network)` and `(network, address)`. `derivation_path` recorded
so we can re-derive if the DB is lost but the HD master mnemonic
survives.

**`deposits`** — one row per on-chain Transfer to a known address. Keyed
by `(network, tx_hash, log_index)` so the same tx hash can hold multiple
ERC20 Transfer events (rare, but possible with contract multicalls).
Lifecycle: `seen` → `confirming` → `credited` (or `orphaned` on chain
reorg). `wallet-watcher` writes new rows from chain events; the
deposit processor ticks confirmations and credits at threshold (Tron
19, ETH 12 — configurable in `services/wallet-watcher/internal/config`).

**`withdrawals`** — user-initiated. **MVP is admin-driven** (no signer
service yet): `requested` → admin approves (`approved`) → human or
signer broadcasts on-chain → admin posts tx hash (`submitted`) → admin
posts confirmation (`confirmed`). At `confirmed`, the wallet is
debited and a `withdrawal` ledger row is written. Failure escapes:
`requested` can be `cancelled` by the user; admin can `mark-failed`
from `approved` or `submitted`, releasing the lock.

### Catalog (Sport > Category > Tournament > Match)

User mandate: maintain a four-level hierarchy for future traditional-sports
support. Oddin esports skip Category; we auto-create a dummy one per sport
(`is_dummy=true`, same slug as sport). Traditional sports later will have
real categories (countries like "England", or "International").

**`sports`** — esports + future traditionals. `provider_urn` maps to Oddin's
`od:sport:*`. Unique on `(provider, provider_urn)` and `slug`.

**`categories`** — child of sport. `is_dummy=true` when auto-created for an
esport. `provider_urn` may be NULL (dummy) or hold a real Oddin URN later.

**`tournaments`** — child of category. `provider_urn` unique globally.

**`matches`** — `BIGSERIAL` id because we'll have a lot of them. `provider_urn`
like `od:match:1234`. `live_score` is a free-form JSONB (different games have
different scoring). `best_of` captures BO1/BO3/BO5. `oddin_status_code` keeps
the raw Oddin status byte for debugging; our normalized `status` column is
the one code should branch on.

### Markets & odds

**`markets`** — parents of outcomes. Unique key
`(match_id, provider_market_id, specifiers_hash)` where `specifiers_hash` is
sha256 of the sorted `k=v|k=v` canonical form of `specifiers_json`. Same
market id with different specifiers (e.g. `{"map":"1"}` vs `{"map":"2"}`) are
distinct rows. `status` tracks Oddin's market status codes (1 active, 0
inactive, -1 suspended, -2 handed over, -3 settled, -4 cancelled).

**`market_outcomes`** — per-outcome state. `raw_odds` is what Oddin sent;
`published_odds` is what we showed to users after applying the payback margin
from `odds_config`. `probability` (NUMERIC(8,7)) is Oddin's
`probabilities="..."` attribute on the outcome — populated for every
active outcome on the integration broker and the source-of-truth input
for the cashout algorithm. `result` + `void_factor` are filled in by the
settlement worker.

**`odds_history`** — append-only, partitioned daily. Used for admin PnL
drill-down and disputed-bet audits. Retention 90 days online via `pg_partman`;
older partitions are dropped (or, in production, detached and archived).

**`odds_config`** — per-scope payback margin in basis points (0–5000 =
0%–50%). The scope cascade at lookup time is
`market_type → tournament → sport → global`; first match wins. Edited by
admins; every change is also written to `admin_audit_log`.

### Tickets

**`tickets`** — one per bet submission. `idempotency_key` is a unique
constraint that lets the client retry POST /bets safely. `stake_micro`,
`potential_payout_micro`, and `currency` are fixed at placement.
`actual_payout_micro` is written at settlement; NULL until then. Settlement
uses `currency` to find the right `(user_id, currency)` wallet row when
crediting payouts, refunds, and rollback adjustments.

States:
- `pending_delay` — bet-delay worker hasn't finalized yet (user has
  `bet_delay_seconds > 0`).
- `accepted` — live, waiting for settlement.
- `rejected` — failed validation or odds-drift check. Stake refunded.
- `settled` — all selections resolved, payout applied.
- `voided` — manually voided by admin, or cancelled by feed before
  settlement.
- `cashed_out` — user sold the ticket back via the cashout flow
  (Sportradar §2.1.1; see migration 0015). `actual_payout_micro` holds
  the offer they accepted; settlement is permanently inhibited (the
  `t.Status != "accepted"` gate in `maybeSettleTicket` prevents
  double-payment even if the underlying market settles afterwards).

Indexes include a partial `WHERE status='pending_delay'` on `not_before_ts`
to make the bet-delay sweep query trivially cheap.

**`ticket_selections`** — one per market on a combo; singles have exactly
one. `odds_at_placement` is frozen at bet time so settlement payout math is
independent of later odds changes. `probability_at_placement` is
snapshot from `market_outcomes.probability` so cashout can later show
"value at placement" and run the optional "significant change" gate
without reconstructing it from odds (NUMERIC(8,7); null when the feed
hadn't shipped a probability for that outcome yet — falls back to
`1/oddsCurrent` inside the cashout engine). Partial index `WHERE result
IS NULL` gives settlement a tight index to scan when it needs to find
unresolved selections for a market.

### Settlement

**`settlements`** — apply-once log for incoming Oddin settlement messages.
Unique key
`(event_urn, market_id, specifiers_hash, type, payload_hash)`
where `payload_hash` is sha256 of the canonicalized XML. An `ON CONFLICT DO
NOTHING` with `RETURNING id` tells the worker whether it actually inserted
(do work) or it's a replay (skip). `payload_json` retained for audit.

### Cashout

**`cashout_config`** — per-scope cashout knobs. Same cascade as
`odds_config` (`market_type → tournament → sport → global`); admin
edits go through `/admin/cashout-config` with audit-log entries.
Columns:

| Column | Default | Notes |
| --- | --- | --- |
| `enabled` | `TRUE` | Master kill-switch per scope. |
| `prematch_full_payback_seconds` | 600 (global) | Within N seconds of placement, while the match has not yet started, the offer is set to the stake. "Cancel as cashout" cooling-off window. 0 disables. |
| `acceptance_delay_seconds` | 5 (global) | Server holds an accepted cashout this many seconds before commit. Mirrors `users.bet_delay_seconds` for placement — gives the bookmaker a window to bail if odds move beyond tolerance. 0–60. |
| `deduction_ladder_json` | `NULL` | Optional `[{factor, deduction}]` ladder for chapter §2.1.2 of Sportradar's cashout doc. `NULL` = pure simple cashout. |
| `min_offer_micro` | 100,000 (global) | Below this absolute offer, return `unavailable` rather than offer pennies. |
| `min_value_change_bp` | 0 | "Significant change" gate: only offer when `\|currentValue/stake − 1\| ≥ bp/10000`. |

A partial unique index `WHERE scope='global'` prevents duplicate global
rows (Postgres treats `NULL` as distinct, so plain
`(scope, scope_ref_id)` doesn't cover global by itself — same fix that
landed for `odds_config` in 0010).

Across combo legs the resolver picks the most-restrictive value:
`enabled=AND`, `prematch=MIN`, `acceptance_delay=MAX` (more cautious
wins), `min_offer=MAX`, `min_change=MAX`. The deduction ladder is the
first non-null leg's ladder.

**`cashouts`** — quote / accept records. One row per `GET
/tickets/:id/cashout/quote` call (only for `available` quotes —
unavailable ones are computed but not persisted, so 5 s polling × 1000
users doesn't burn the table). `status` lifecycle: `offered` → either
`accepted` (terminal, money moved) or `expired` / `errored` /
`declined`. `unavailable` exists for legacy rows. `offered_micro` is
the locked amount the user agreed to; `payout_micro` is what was
actually paid (always equal to `offered_micro` for accepted rows
today). `ticket_odds_snapshot`, `probability_snapshot`, and
`deduction_factor_snapshot` capture the inputs for support / audit.

> **One accepted per ticket.** A partial unique index
> `WHERE status='accepted'` on `ticket_id` is the apply-once backstop
> against double-cashout under concurrent accept races. The
> `wallet_ledger` `(type='cashout', ref_type='ticket', ref_id=ticketId)`
> unique partial index is the second backstop on the wallet side.

### Admin + ops

**`mapping_review_queue`** — auto-created entities (sports, tournaments,
matches, market types) that didn't have a pre-existing mapping land here with
`status='pending'`. Admin UI at `/admin/mapping` approves or rejects. A
partial index `WHERE status='pending'` keeps the queue scan fast.

**`admin_audit_log`** — structured record of every admin mutation. Includes
JSONB before/after snapshots so we can reconstruct state post-hoc.

**`amqp_state`** — persists Oddin producer recovery watermarks. Row keys are
namespaced strings (`"producer:1"` for pre-match, `"producer:2"` for live).
`after_ts` is the timestamp (ms since epoch) we'd pass to the snapshot
recovery REST endpoint after an AMQP reconnect.

**`chain_scanner_state`** — per-chain cursor for `wallet-watcher` (added in
migration 0002). One row per chain (`TRC20`, `ERC20`).
`last_block_number BIGINT` — for ETH this is a block number; for Tron it's
a ms timestamp (the column is generic, used for whatever monotonic
position the chain exposes through its API). The `BumpCursor` helper
never regresses (`GREATEST(current, new)`).

**`feed_messages`** — raw AMQP message log surfaced by `/admin/logs`
(added in migration 0011). One row per match-scoped Oddin message
processed by feed-ingester (`odds_change`, `fixture_change`, `bet_stop`,
`bet_settlement`, `bet_cancel`, `rollback_bet_settlement`,
`rollback_bet_cancel`). Columns: `id`, `match_id` (nullable FK to
`matches.id` with `ON DELETE CASCADE` — resolved at insert via subquery
on `provider_urn`), `event_urn`, `kind`, `routing_key`, `product`
(SMALLINT 1=pre / 2=live), `payload_xml` (verbatim XML), `received_at`.
Indexes: `(match_id, received_at DESC) WHERE match_id IS NOT NULL`,
`(received_at)` for cleanup, `(event_urn, received_at DESC) WHERE
event_urn IS NOT NULL`. Retention is enforced from feed-ingester:
`runFeedMessageCleanup` deletes rows whose match has passed
`scheduled_at + 24h`, plus a hard 48h ceiling for unmapped URNs.
Insertion is best-effort — failures log and continue so a transient
DB hiccup never stalls the AMQP consumer.

**System-level kinds (`alive`, `snapshot_complete`) are intentionally
not logged** — they're heartbeats / recovery markers, not match-scoped
debugging signal. Settlement messages are dispatched by the
settlement worker but feed-ingester sees them too on the same broker
topic, so the per-match log is complete from a single write site.

## Common queries

```sql
-- User's open tickets
SELECT * FROM tickets
  WHERE user_id = $1 AND status IN ('pending_delay','accepted')
  ORDER BY placed_at DESC;

-- Unresolved selections for a market (hit by settlement worker)
SELECT * FROM ticket_selections
  WHERE market_id = $1 AND result IS NULL;

-- PnL for last 24h by sport, USDT only (filter OZ out — it's demo money)
SELECT s.slug AS sport,
       SUM(CASE WHEN wl.type='bet_stake'  THEN -wl.delta_micro ELSE 0 END) AS stakes,
       SUM(CASE WHEN wl.type='bet_payout' THEN  wl.delta_micro ELSE 0 END) AS payouts,
       SUM(CASE WHEN wl.type='bet_payout' THEN  wl.delta_micro ELSE 0 END)
         - SUM(CASE WHEN wl.type='bet_stake' THEN -wl.delta_micro ELSE 0 END) AS pnl_micro
  FROM wallet_ledger wl
  JOIN tickets t   ON wl.ref_type = 'ticket' AND wl.ref_id = t.id::text
  JOIN ticket_selections ts ON ts.ticket_id = t.id
  JOIN markets m   ON m.id = ts.market_id
  JOIN matches ma  ON ma.id = m.match_id
  JOIN tournaments tu ON tu.id = ma.tournament_id
  JOIN categories c   ON c.id = tu.category_id
  JOIN sports s       ON s.id = c.sport_id
  WHERE wl.created_at >= NOW() - INTERVAL '24 hours'
    AND wl.currency = 'USDT'
  GROUP BY s.slug
  ORDER BY pnl_micro DESC;

-- Lookup current odds for a match
SELECT m.id AS market_id, m.provider_market_id, m.specifiers_json,
       mo.outcome_id, mo.name, mo.published_odds, mo.probability, mo.active
  FROM markets m
  JOIN market_outcomes mo ON mo.market_id = m.id
  WHERE m.match_id = $1 AND m.status = 1 AND mo.active;

-- Daily cashout PnL (admin view): how much the book made or lost via
-- cashout vs the alternative outcome (let it run to settlement).
SELECT date_trunc('day', c.executed_at) AS day,
       count(*)                         AS cashouts_taken,
       SUM(t.potential_payout_micro - c.payout_micro) AS counterfactual_save_micro,
       SUM(c.payout_micro - t.stake_micro)            AS realized_pnl_micro
  FROM cashouts c
  JOIN tickets  t ON t.id = c.ticket_id
  WHERE c.status = 'accepted'
    AND c.executed_at >= NOW() - INTERVAL '30 days'
  GROUP BY day
  ORDER BY day DESC;
```

## Migration workflow

1. Edit `packages/db/src/schema/<file>.ts`.
2. Write the equivalent SQL in `packages/db/migrations/<next>_<desc>.sql`.
3. Update `packages/db/migrations/meta/_journal.json` with a new entry.
4. `make migrate` applies the new file(s) in a transaction per file and
   records success in the `_migrations` table.
5. Commit.

We don't use `drizzle-kit migrate` — our migrations include Postgres features
(partitioning, extensions) Drizzle can't emit. Drizzle owns the TS schema for
typed queries; SQL files are the runtime source of truth.
