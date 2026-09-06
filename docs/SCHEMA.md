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
  effective margin at placement compounds multiplicatively as
  `(1 + margin_bp) × (1 + margin_bp_per_leg)^N − 1`, mirroring how a
  combo's overround compounds via its odds product. Tippot defaults to
  0 + 500 (5% per leg compounded — N=5 ≈ 27.6%); Tiple stays at 1500 + 0
  (flat 15%).
- `0019_fe_market_display_order.sql` — `fe_market_display_order` table
  keyed by `(sport_id, provider_market_id)` with `display_order INTEGER`.
  Per-sport storefront override of the default `provider_market_id`
  ascending order on the match-detail page. Smaller `display_order` =
  higher priority; markets with no row fall back to the legacy default
  (provider_market_id ascending). Configured via
  `/admin/fe-settings/markets-order`, consulted by `/catalog/matches/:id`.
- `0020_fe_market_order_scope.sql` — adds `scope TEXT` column to
  `fe_market_display_order` (CHECK in `match` / `map` / `top`) and
  re-keys the unique constraint to `(sport_id, scope, provider_market_id)`.
  Three scopes: `match` (markets without a `map` specifier), `map`
  (markets carrying a `map` specifier — one shared ordering applies to
  every Map N tab), `top` (curated highlights; empty by default,
  rendered as a "Top" tab on the match-detail page and an inline tab
  toggle on match list cards via `loadTopMarketIdsBySport` /
  `loadTopMarketsForMatches` in `services/api/src/modules/catalog/routes.ts`).
  Superseded twice since: `0057_fe_market_order_per_map` replaced the
  shared `map` scope with one independent `map_<N>` list per map tab,
  and `0084_fe_market_groups` added `custom_<key>` scopes — admin-created
  curated tabs whose label + tab position live in the new
  `fe_market_groups` table (`(sport_id, scope)` unique; custom rows carry
  a NOT NULL `label`, built-in scopes get label-NULL anchor rows that
  carry `display_order` when the admin reorders tabs; tabs with a row
  sort first by `display_order`, the rest keep the default Top, Match,
  Map 1..N order). `0106_fe_market_scope_sub_events` added the fourth
  family, `fb_<kinds>` — one scope per Fonbet sub-event, id derived from
  the `variant` specifier (`fb:400100/10100201` → `fb_400100_10100201`,
  every per-player variant collapsing into `fb_players`). Those tabs had
  been rendered by the match page since the Fonbet line landed but were
  not addressable, so the backoffice offered every sport the esports
  shape (Match + Map 1..5) and the tabs bettors actually saw could not be
  ordered. The scope grammar for all four families lives in
  `packages/types/src/market-scope.ts`; the CHECK constraints on both
  tables mirror it.
  `0109_fe_market_order_variant` then added `variant` to
  `fe_market_display_order` and re-keyed its unique to
  `(sport_id, scope, provider_market_id, variant)`. A curated tab picks a
  market, not a market TYPE: `provider_market_id` is the catalogue table,
  which Fonbet reuses across every sub-event, so football's ~470 markets
  collapse to 14 ids and "Corners: Total" could not be featured without
  also meaning "Total". The empty string keeps its original meaning — any
  copy, resolved by the storefront's representative pick — so no row was
  backfilled and every pre-existing configuration resolves as before.
  Meaningful only for the curated scopes; a feed tab is already one
  sub-event and leaves it empty.
  `20260906T014417_fe_market_group_membership` finished the job by making every tab
  editable the same way, adding `fe_market_groups.membership TEXT NOT NULL
  DEFAULT 'auto'` (CHECK `IN ('auto','manual')`). Until then a feed tab
  was order-only — membership was the feed's call — so a market could
  neither be pulled onto a tab from another sub-event nor left off a tab
  that carries it. A row's `variant` is now honoured on every scope, and
  the new column says what the list MEANS on a feed tab: `'auto'` renders
  the listed markets first and lets the feed keep filling the rest
  (byte-identical to the old behaviour, and what every existing row
  means), `'manual'` makes the list the whole tab, as `top` and custom
  groups always were. **The default is load-bearing**: the backoffice pool
  is derived from the CURRENT offer (open matches only), so a market kind
  that is not live when the operator saves is simply not on screen —
  flipping configured tabs to explicit membership would have silently
  dropped those from the storefront. Resolution lives in
  `services/api/src/lib/market-groups.ts` (pure, unit-tested): a row
  naming a sub-event admits that market's whole ladder, a wildcard row on
  a feed tab resolves within that tab, and a wildcard row on a curated tab
  keeps its pre-0109 "any copy, one representative" meaning. Reverting a
  tab to default clears the rows AND resets `membership` — a `'manual'`
  tab with no rows would render empty — and the tab-reorder endpoint no
  longer drops anchor rows carrying `'manual'`.
- `0021_competitor_logos.sql` — adds `competitors.logo_url TEXT` and
  `competitors.brand_color TEXT` for storefront team branding. Both
  are nullable; a CHECK constraint requires
  `brand_color ~ '^#[0-9A-Fa-f]{6}$'` when present. `logo_url` holds
  the cdn.oddin.gg URL Oddin returns from its competitor-profile REST
  endpoint — we hot-link the CDN directly (they're our authorised
  data partner). Catalog endpoints LEFT JOIN `competitors` twice
  (home + away aliases) to surface `homeLogoUrl` / `awayLogoUrl` on
  every match row + match detail. Admins can paste a manual URL via
  `/admin/competitors` (PATCH /admin/competitors/:id); the bulk
  resolver `pnpm --filter @oddzilla/db db:resolve-logos`
  ([`packages/db/src/resolve-logos.ts`](../packages/db/src/resolve-logos.ts))
  is a single SQL UPDATE that copies
  `competitor_profiles.icon_path` (cached by feed-ingester from
  Oddin's REST profile endpoint) onto `competitors.logo_url`.
- `0022_match_tv_channels.sql` — `matches.tv_channels jsonb` storing
  the parsed `<tv_channels>` block from Oddin's fixture endpoint.
  Twitch / YouTube broadcasters render as a live-stream embed above
  the markets on the match-detail page; fixture_change `STREAM_URL`
  (106) triggers a REST refresh.
- `0023_settlements_market_id_idx.sql` — plain btree on
  `settlements(market_id)` so reverse-FK probes by market_id can use
  an index. The existing `(event_urn, market_id, …)` unique can't
  because event_urn leads. Without it, the recovery flush's
  `NOT EXISTS` over 4M settlement rows seq-scanned and ran for over a
  minute.
- `0024_community_profiles.sql` — Phase 10.1 community surface. Adds
  four columns to `users`:
  - `tickets_public BOOLEAN NOT NULL DEFAULT TRUE` — Decision D1 in
    [`COMMUNITY_PLAN.md`](./COMMUNITY_PLAN.md). Maximises feed density
    on day one; one-click opt-out at `/account/community`.
  - `nickname citext UNIQUE` — public handle in `/u/[nickname]` and on
    every community card. citext keeps comparisons case-insensitive
    without a separate `lower()` index. NULL until the user picks one.
    A CHECK constraint enforces the `[A-Za-z0-9_]{3,20}` format,
    mirroring the zod cap at the API layer.
  - `bio TEXT` — short profile bio. NULL by default; CHECK caps
    `length <= 280`, mirroring the API zod cap.
  - `is_ai BOOLEAN NOT NULL DEFAULT FALSE` — internal flag for AI seed
    accounts (Phase 10.4). Decision D2: never serialised by any API
    endpoint. Transparency-on-request only.
- `0025_community_tickets.sql` — Phase 10.2 community feed projection.
  Adds `community_tickets`: a denormalised read model of every
  publicly-resolved ticket (`status IN ('settled', 'cashed_out',
  'voided')`). `UNIQUE (ticket_id)` makes the upsert idempotent under
  settlement replay; `ON CONFLICT DO UPDATE` keeps status / payout /
  settled_at synchronised with the source-of-truth `tickets` row across
  rollback / re-settle generations. `sport_ids INTEGER[]` is computed
  by joining `ticket_selections → markets → matches → tournaments →
  categories` and is used (via the GIN index) for the
  filter-by-sport feed query. Authoritative writer is
  `services/settlement` (Go) inside `SettleTicket` /
  `ReverseSettledTicket`; cashout (`services/api`, TS) writes the
  projection inline; the admin endpoint `POST /admin/community/
  backfill` recovers any miss.
- `0029_community_achievements.sql` — Phase 10.4 starter badges.
  - `achievement_definitions` — hand-curated badge catalog. `id` is a
    stable text slug; `icon` references a lucide-icon slug from
    `apps/web/src/components/ui/icons.tsx`; `sort_order` controls
    profile display ordering. No admin CRUD planned — edit via direct
    DB ops if the product team renames or retires a badge.
  - `user_achievements` — unlock log. Composite PK
    `(user_id, achievement_id)` is the idempotency story for the
    evaluator that runs after every projection write. Cascade on user
    delete; achievement definitions never delete in practice but the
    cascade prevents orphan rows if one ever does.
  - Five starter badges seeded inline: `first_win`, `combo_5` (5+ leg
    combo win), `odds_20` (win at 20.00+ total odds), `payout_100x`
    (single ticket payout ≥ 100× stake), `streak_10` (10+ wins
    cross-currency). All predicates are currency-agnostic — absolute-
    payout badges that need currency segregation belong to a later
    iteration once leaderboards mature.
  - Evaluation runs co-located with the projection write hook. See
    [`services/settlement/internal/store/store.go`](../services/settlement/internal/store/store.go)
    `EvaluateAchievements` (Go) and
    [`services/api/src/modules/community/achievements.ts`](../services/api/src/modules/community/achievements.ts)
    `evaluateAchievements` (TS). Both run the same SQL — `INSERT ...
    ON CONFLICT DO NOTHING` against the composite PK. Rollback paths
    don't revoke; achievements are facts about user history.
- `20260906T015446_combozilla_config.sql` — the lobby's ComboZilla carousel
  becomes configurable. `combozilla_config` singleton (master switch,
  `eligible_risk_tiers smallint[]`, `allow_untiered`,
  `multi_card_sport_slugs text[]`; defaults reproduce the constants the web
  builder had hard-coded) + `combozilla_scope_rules` (allow / block on a
  sport, category or tournament; most specific wins). See "ComboZilla" under
  Table groups.

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

`family_id UUID NOT NULL` + `parent_session_id UUID` (PR #130) implement
refresh-token replay detection. Login starts a fresh family
(`family_id=randomUUID()`); refresh continues an existing one
(`family_id=parent.family_id`, `parent_session_id=parent.id`). If a
client presents a refresh token whose session is **already revoked**,
that's the canonical theft signal — `AuthService.refresh` then revokes
every active session in the family in one statement and flips each
session's Redis `session:status:{sid}` cache to `revoked`, so any access
JWT that was minted in that family stops working immediately rather
than hanging around for its 15-minute lifetime.

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

`block_hash TEXT` (PR #130) is captured at insert time for ETH
deposits. Before crediting, the processor calls
`Scanner.VerifyDeposit(dep)` — for ETH this looks up
`eth_getBlockByNumber(block_number)` and compares the canonical hash;
mismatch flips the row to `status='orphaned'` instead of crediting.
Tron path is confirmation-driven (TronGrid `only_confirmed=true` filter
already means events are past finality at ~19 confirmations) and
returns true unconditionally. Pre-migration rows have `block_hash=NULL`
and skip-verify.

For TRC20, multi-Transfer txs no longer collide on
`(network, tx_hash, log_index=0)` — the scanner now captures
`event_index` per Transfer (PR #130), so two events to the same address
in one tx produce two distinct deposit rows.

**`withdrawals`** — user-initiated. **MVP is admin-driven** (no signer
service yet): `requested` → admin approves (`approved`) → human or
signer broadcasts on-chain → admin posts tx hash (`submitted`) → admin
posts confirmation (`confirmed`). At `confirmed`, the wallet is
debited and a `withdrawal` ledger row is written. Failure escapes:
`requested` can be `cancelled` by the user; admin can `mark-failed`
from `approved` or `submitted`, releasing the lock.

`approved_by_user_id`, `submitted_by_user_id`, `confirmed_by_user_id`
(PR #130) record the admin actor at each lifecycle step. The CHECK
constraint `withdrawals_distinct_approver_confirmer` enforces
`confirmed_by_user_id ≠ approved_by_user_id` so a single compromised
admin token cannot drain a wallet by approving + confirming alone.
The unique partial index on `(network, tx_hash) WHERE tx_hash IS NOT NULL`
rejects a duplicate hash at DB layer (also enforced per-network at the
route via regex). Lock-release paths (user cancel, admin reject, admin
fail) write `wallet_ledger` audit rows (`adjustment` type with
`withdrawal_cancel` / `withdrawal_reject` / `withdrawal_fail`
ref_type) so every `wallets.locked_micro` decrement has a visible
trail.

### Catalog (Sport > Category > Tournament > Match)

User mandate: maintain a four-level hierarchy for future traditional-sports
support. Oddin esports skip Category; we auto-create a dummy one per sport
(`is_dummy=true`, same slug as sport). Traditional sports later will have
real categories (countries like "England", or "International").

**`sports`** — esports + future traditionals. `provider_urn` maps to Oddin's
`od:sport:*`. Unique on `(provider, provider_urn)` and `slug`.

**`categories`** — child of sport. `is_dummy=true` when auto-created for an
esport. `provider_urn` may be NULL (dummy) or hold a real Oddin URN later.

#### `display_order` — operator pin ordering (migration 0103)

A nullable `INTEGER` on BOTH `sports` and `categories`. NULL means the row
is not pinned, which is what every row held before an operator touched it,
so the storefront's ordering is byte-identical to the pre-migration one on
an untouched estate. A pinned row sorts by this value ascending ahead of
every unpinned row; unpinned rows keep the rule that governed them before —
flagship slugs (`cs2`, `dota2`, `lol`, `valorant`) then alphabetical for
sports, alphabetical for category buckets.

Scope differs by table, and the difference is the point. Sports are ONE
global sequence: a sport has no parent, so its position is a statement about
the whole rail. Categories are one sequence PER SPORT: a category only ever
renders inside its own sport's sidebar tree, so "second from the top" is a
statement about Football, and a global sequence would make every sport
contend for the same integers.

The pinned set is stored dense (1..N) and **renumbered on every action**.
That is why the write path goes through the pure transform
`reorderPinned` (`services/api/src/lib/pin-order.ts`) rather than arithmetic
on a single row: rewriting the whole list makes the sequence self-healing
against gaps left by a deleted row or duplicates written by hand, and "up" /
"down" are only definable relative to the other pinned rows in the first
place. There is deliberately **no unique constraint** — a non-deferred one
would fail mid-renumber — and **no index**, because both tables are small
enough (under a hundred sports, a few thousand categories) that an index
would cost writes to serve a sort that is already free.

Migration 0104 extends the same column to `tournaments`, scoped to the
CATEGORY — the bucket a tournament actually renders in, so a position is
a statement about England rather than about football. Esports tournaments
all sit under one synthetic dummy category per sport, which is also how
the storefront draws them, so the scope matches there too.

Written only by `POST /admin/sports/:id/order`,
`POST /admin/tournaments/:id/order` and
`POST /admin/categories/:id/order` (`{action: top|up|down|clear}`, both
audit-logged). Each takes every lock in one primary-key-ordered
`SELECT … FOR UPDATE`: locking the clicked row and then the pinned set is
two acquisitions in click-dependent order, which is how two admins
reordering the same scope would deadlock each other.

`hidden_from_lists BOOLEAN NOT NULL DEFAULT FALSE` (migration 0102) keeps a
category in the sidebar tree but out of every match list a bettor gets
WITHOUT asking: the lobby, `/live`, `/upcoming`, the sport page's default
view, and the per-sport live badge on `/catalog/live-counts`. Any explicit
narrowing — `?category=`, `?tournament=` or `?team=` on
`/catalog/sports/:slug` — drops the predicate, so the offer stays one click
away; the tree's own per-category and per-tournament counts deliberately
still count the hidden rows, because the tree is where a bettor goes to find
them.

The case it exists for: Fonbet files EA FC simulations
("FC 26. ESportsBattle. La Liga. 2x4 min.") under the real Football sport,
so 184 of ~1770 bookable Football matches — and 10 of 23 live ones — were
computer-played 2x4-minute games sitting above the actual football offer.
The same shape recurs as NBA 2K26 under Basketball and NHL 26 under Ice
Hockey. The migration seeds `TRUE` for `name ~ '^FC [0-9]{2}$'` (exactly
`FC 24` + `FC 26` on the current line, verified before shipping); everything
else is an operator call on `/admin/categories`.

Deliberately NOT `categories.active = false`: these matches are real,
bettable and settle normally, so this is a merchandising decision and the
two flags stay independent. Also deliberately not the
`HIDDEN_TOURNAMENT_NAMES` treatment in the catalog routes — that one hides
rows that should never be reachable (Oddin's integration-test tournament),
this one hides rows that shouldn't be the default.

**`feed_control`** (migration 0095) — singleton row (`id = 1`) holding the
operator's feed source switch: `source` (`auto` / `prod` / `backup`),
`switched_at`, `switched_by`, plus feed-ingester's acknowledgements
`flushed_at` (stamped after the catalogue flush on a switch into backup;
bifrost-feed waits for `flushed_at >= switched_at` before re-emitting) and
`applied_source` / `applied_at`. Written by `PUT /admin/feed/source`
(audit-logged), read every 2 s by feed-ingester and bifrost-feed. In
Postgres, not Redis, because production Redis is an `allkeys-lru` cache
that evicted the first cut's keys on day one and silently undid a forced
Backup. Migration 0099 adds the **Fonbet feed on/off switch** to the same
row: `fonbet_enabled BOOLEAN NULL` (NULL = follow the `FONBET_ENABLED` env
default; TRUE / FALSE = the operator's explicit position, which wins over
env and survives restarts and deploys), `fonbet_switched_at` /
`fonbet_switched_by`, and fonbet-ingester's acknowledgement
`fonbet_applied_enabled` / `fonbet_applied_at`. Written by
`PUT /admin/feed/fonbet` (audit-logged), read every 2 s by fonbet-ingester,
which suspends the whole Fonbet catalog and stops polling on FALSE and
boots the feed in place on TRUE.

**`tournaments`** — child of category. `provider_urn` unique globally.
`risk_tier_locked` (migration 0094) is TRUE when an operator assigned
`risk_tier` by hand on `/admin/tournaments`; feed-ingester's REST refresh
(`UpdateTournamentRiskTier`) skips locked rows. Exists because the Bifrost
backup feed carries no risk tier, so a tournament first seen while Oddin's
meta API is down would otherwise sit at NULL and RiskZilla would price it
off the tier-0 fallback.

Migration 0106 records **who** decided the tier. `risk_tier_source` is
CHECK-constrained TEXT — `auto` (feed-assigned, or never reviewed),
`manual` (an operator typed it; implies `risk_tier_locked`), `zagi` (a
ZillaAGI review) — alongside `risk_tier_note` (the reviewer's one-line
justification, ≤ 500 chars, model output so it renders as text and never
as markup), `risk_tier_reviewed_at`, and `risk_tier_attempts` (bounded
retry, max 3, so a name the model will not judge stops being re-sent).
TEXT rather than an enum because adding an enum value has to be its own
migration file — the rule 0087 and 0101 both hit.

The state worth separating is not manual-vs-automatic but
**reviewed-vs-not**: `auto` used to cover both "Oddin supplied this
number" and "nobody has ever looked", and on production the second kind
was 1 231 of 1 870 rows. Note the direction of the risk before changing
anything here — RiskZilla prices a NULL tier at `UNTIERED_RISK_TIER = 10`,
the STRICTEST row in `riskzilla_settings` (50 USDC match liability against
tier 1's 50 000), so an untiered tournament is never over-exposed, and
every tier assigned to one *raises* what the book can lose on it. There is
no assignment here that is cautious by omission, which is why the reviewer
clamps every verdict to a per-sport ceiling in code and writes nothing at
all when it cannot parse a reply.

Migration 0108 adds logo provenance: `logo_source` (`fonbet` /
`wikidata` / `liquipedia` / `manual`), `logo_source_url`, `logo_attempts`
(bounded retry) and `logo_checked_at`. It exists because the marks the
feeds do not carry have to be sourced from third parties, and two
properties follow from that. Liquipedia's logos are largely non-free, so
`WHERE logo_source = 'liquipedia'` must be enough to revert the whole
set. And automatic matching is wrong often enough to need auditing —
measured on real names, Wikidata resolves "EuroLeague" to the WOMEN'S
competition and Liquipedia's search for "PGL Wallachia" to a team page —
so every automatic row records what decided it. The resolver only ever
writes where `logo_url IS NULL`, so an operator's upload is never
overwritten.

Migration 0107 adds two standing tightenings on top, applied in code to
every new verdict and retroactively to the rows the first sweep had
already written: **+1 on every ZAGI verdict** (a machine judgement is not
reviewed by a person before it takes effect, so ZAGI can never assign T1)
and **+3 for outright markets** (they resolve over a season or phase, so
the book carries the position for months and cannot trade out of it match
by match). Both only ever raise the number. `risk_tier_note` records the
whole chain — the model's words, its own tier, then each step — and the
literal `+1 ZAGI safety margin` inside it is the backfill's idempotency
key, so a row can never be stepped twice.

**`matches`** — `BIGSERIAL` id because we'll have a lot of them. `provider_urn`
like `od:match:1234`. `live_score` is a free-form JSONB (different games have
different scoring). `best_of` captures BO1/BO3/BO5. `oddin_status_code` keeps
the raw Oddin status byte for debugging; our normalized `status` column is
the one code should branch on. `tv_channels` (jsonb, migration 0022) holds
the parsed `<tv_channels>` block from Oddin's fixture endpoint —
`[{"name":"Twitch EN","language":"en","streamUrl":"https://www.twitch.tv/…"}, …]`.
NULL = fixture not fetched yet or block missing; `[]` is unused (the
resolver only writes when at least one row carries a stream_url so a
later refresh can't blank a known list with placeholders). Display-only;
bet placement does not consult it.

**`match_sportradar_ids`** (migration 0100) — the Oddzilla ↔ Sportradar
link, one row per match (`match_id` PK, `ON DELETE CASCADE`). Columns:
`sr_match_id`, `sr_sport_id` (Sportradar's own sport taxonomy — 1 soccer,
12 rugby, 137 esoccer; stored per row rather than looked up so a one-off
correction is expressible), `status` (`candidate` / `confirmed` /
`rejected`), `source` (`admin` / `auto` / `llm` — migration 0101; `llm` is the model
that adjudicates the matcher's queue, recorded separately so the desk can
show who decided and a bad batch is revertible in one statement),
`confidence` (0..1, NULL when a human typed the id), `evidence` jsonb (the Sportradar-side names and
kickoff, the per-team scores, and any runners-up), and
`reviewed_by_user_id` / `reviewed_at`.

Why a table at all, when the other two id spaces need none: `matches.id`
is already Oddzilla's own id for every fixture from every feed, and
`matches.provider_urn` already carries the feed's (`od:match:<n>` /
`fb:match:<n>`). Sportradar's is carried by neither — measured
2026-09-04, a full 13 667-event Fonbet snapshot has no external-id field
on any event, and their match pages load statistics only from their own
hosts.

It *is* fetchable from Sportradar's statistics host
(`sport_matches/<srSportId>/<date>`, which answers ordinary
server-to-server requests — their LMT host is a different matter and
refuses everything off a licensed origin), but with no shared key on
either side the link has to be **inferred** from kickoff time and team
names. That inference is what the review state and the provenance columns
exist for: the SR id is the only one of the three that can be *wrong*.

Two indexes carry rules rather than performance. `match_sportradar_srid_uniq`
is UNIQUE on `sr_match_id` **`WHERE status <> 'rejected'`**: one live
mapping per Sportradar fixture, while a rejected row stays as a tombstone
that never blocks the correct match from claiming the same id.
`match_sportradar_status_idx` on `(status, confidence)` orders the admin
review queue weakest-first. CHECKs pin `confidence` to [0, 1] and require
`reviewed_by_user_id` and `reviewed_at` to be set together.

Only `confirmed` rows reach the storefront (`/catalog/matches/:id` filters
on it) — a wrong mapping would put another fixture's live statistics on the
match page, so an unworked review queue means a missing tracker, never a
wrong one.

**`match_external_ids`** (view, migration 0100) — every id this platform
holds for a match in one shape: `(match_id, provider, external_id, status,
confidence)`. The `oddin` and `fonbet` rows are DERIVED from
`matches.provider_urn` with `substring(provider_urn FROM 10)` (both
prefixes are exactly 9 characters) rather than copied into a table, because
a copy could only ever drift from the unique-indexed original. The
`sportradar` rows come from `match_sportradar_ids`. Rows whose URN is
`od:tournament:%` — the auto-mapper's tournament-outright placeholders, 587
of them on 2026-09-04 — are deliberately excluded: they live in `matches`
but are not fixtures, have no kickoff or opponents, and have no Sportradar
counterpart. If outrights become first-class they want their own provider
label here rather than being folded in as matches.

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

**`boosted_odds_config`** — Custom Boosted Odds rules (migration 0085;
`outcome` scope added in 0087-0088). One row per (scope, ref): `scope IN
(sport, tournament, match, competitor, market, outcome)` with a typed FK
per tier (ON DELETE CASCADE) and a partial unique index per scope so an
entity carries at most one rule. `boost_pct NUMERIC(5,2)` is a
Netwinstable key delta in percentage points (same math as ZillaFlash),
recomputed against live `published_odds` on every read: nothing is frozen
in the row.

**Scheduling window.** `starts_at` (migration 0092) NULL means live
immediately; `ends_at` NULL means the boost runs until the operator
removes it. A rule is deliverable only INSIDE the window:

```sql
(starts_at IS NULL OR starts_at <= now())
AND (ends_at IS NULL OR ends_at >  now())
```

Both halves are one shared predicate — `boostWindowIsOpen()` for SQL and
`ruleWindowIsOpen()` in memory, in
[`services/api/src/lib/boosted-odds.ts`](../services/api/src/lib/boosted-odds.ts).
Never write the condition out by hand at a call site: a reader that
checks only `ends_at` will price, display, **and pay out** a boost the
operator scheduled for a future date. The four readers that must apply
it are `loadBoostRulesForMatch`, `loadBoostRulesForMatches`,
`validateCustomBoostForBet` (rejects `boosted_odds_not_started`), and
`GET /catalog/zillaboost-banners`. The `boosted_odds_window_order` CHECK
enforces `starts_at < ends_at` regardless of what the admin route allows.
The graphics-banner job queue is deliberately NOT window-gated —
rendering the artwork before the boost starts is the point.

**Team boost market span.** `competitor_markets` (migration 0093, `NOT
NULL DEFAULT 'all'`, CHECK `IN ('all','team_only')`) applies only to
`scope='competitor'`:

- `all` — every market of every match the team plays, opponent-facing
  and symmetric markets included. The original behaviour, and the
  default, so no pre-existing row changed meaning.
- `team_only` — only the team's OWN outcome, and only in team-shaped
  markets (`provider_market_id IN (1,4)`: match winner and map winner,
  where outcome `1` is the home competitor and `2` the away one). Priced
  through the SELECTION path, so the delta comes out of that outcome's
  own implied probability and the opponent's price does not move. Two
  team_only rules on opposite sides of the same match therefore both
  apply, each to its own cell.

The team-shaped predicate is `isTeamShapedMarket` in
[`packages/types/src/boosted-odds.ts`](../packages/types/src/boosted-odds.ts),
shared by the API and the browser. A team_only rule reaches the client as
`matchWide.teamOutcomeId` — an instruction, not a market list, because a
live match mints new market rows as maps start.

`min_risk_score NUMERIC(4,3)` NULL means every bettor receives it,
otherwise `users.risk_score >= min_risk_score` gates delivery (anonymous
viewers count as the 1.000 default). `banner` (migration 0086) marks the
rule for a storefront home-page promo banner, shaped per scope:

| Scope | Banner surface | Odds on it? |
| --- | --- | --- |
| `market` | ZillaFlash-style offer card | yes, every outcome |
| `match` | scoreless match card | yes, match-winner (falls back to current map winner, then first active market) |
| `competitor` | team card → `/sport/:slug?team=<id>` (migration 0093) | no |
| `tournament` | wide banner → `/sport/:slug?tournament=<id>` | no |
| `sport` | wide banner → `/sport/:slug`, **plus** the sidebar bolt (banner added 2026-08-28) | no |
| `outcome` | none — a single cell has no banner shape | — |

The three broad scopes carry **no odds deliberately**: the rule spans
every market of every match under it, so there is no single price to
quote. The banner is a signpost; the list cards under it carry their own
boosted prices. None of them is gated on `matchCount` — silently
dropping a banner the operator explicitly asked for is what made the
sport case look broken before it had a surface at all.

Managed at `/admin/boosted-odds` (operator-facing name: ZillaBoost);
every mutation is audit-logged.

**Fair-odds warning.** The active-rules overview flags rules whose
`boost_pct` the covered book can't actually deliver, because
`boostMarketKey` floors its target key at 1.0 and silently truncates the
delta rather than going fair-or-better. Computed exactly in SQL from the
book key (`SUM(1/published_odds)` per market, active + priced outcomes on
`status=1` markets, `>= 2` outcomes):

```
clamped   <=>  key <  1.0 + boost_pct/100
dead      <=>  key <= 1.0                  (boost does nothing at all)
best deliverable pct on a clamped market = (key - 1.0) * 100
```

`scope='outcome'` rules are excluded: their binding limit is usually
`SELECTION_BOOST_MAX_PROB_SHARE` (half the cell's own probability), so
the fair-book number alone would be a misleading signal. The algebra is
pinned against the real `boostMarketKey` in
[`packages/types/src/boosted-odds.test.ts`](../packages/types/src/boosted-odds.test.ts)
so the SQL and the TS pricing cannot drift apart.

Resolution per market when rules overlap:
`outcome > market > match > competitor > tournament > sport`. Two
competitor rules on the same match resolve to the higher pct.

**Selection scope (`outcome`)** targets ONE cell instead of a whole
market, keyed by `(market_id, outcome_id)` — the `market_outcomes`
primary key — so it reuses the existing `market_id` column and adds
`outcome_id text` beside it. That keeps the `market_id` FK doing the
cleanup when a market row disappears, and leaves `boosted_odds_market_uniq`
untouched: a market rule and any number of selection rules on the same
market live in different partial indexes. There is deliberately **no FK
on `(market_id, outcome_id)`** — validating one would take SHARE ROW
EXCLUSIVE on `market_outcomes`, which the feed writes to continuously,
and the lock queue that builds behind it is the failure mode migration
0023 was added to fix. The admin route verifies the outcome row exists on
write; an outcome that later leaves the market simply stops resolving.

Two things differ from the market-wide scopes:

- **Math.** The key delta comes out of the boosted outcome's own implied
  probability (`1/odds' = 1/odds − delta`) rather than being spread
  across the outcome set, so its siblings keep their raw price. See
  `boostSelectionKeys` in `packages/types/src/netwinstable.ts`. Two
  clamps bound it: the market key still can never reach fair (1.0), and
  no single outcome may lose more than `SELECTION_BOOST_MAX_PROB_SHARE`
  (half) of its own probability — the fair-book clamp alone doesn't
  bound one cell, since a market's headroom can exceed a longshot's
  entire probability and drive its price to infinity. When several
  selections in one market are boosted and their combined request
  exceeds the headroom, all deltas scale by the same factor (order
  independent, so the client's live compute and the api's placement
  re-validation agree exactly).
- **Precedence is replacement, not ranking.** A market carrying any
  eligible selection rule is priced by its selection rules ALONE — the
  market / match / competitor / tournament / sport rule stops applying
  to it. Composing them would double-dip: the market-wide pass already
  takes the key to its fair-book floor, and a selection delta on top
  would push the book past fair. Enforced in one place
  (`quoteMarketBoost`, `netwinstable.ts`) that the match page, the
  banners endpoint, and `POST /bets` all call; `/catalog/matches/:id/
  boosted-odds` also omits the market-scope entry for such a market, and
  the banner endpoint skips those markets so it never advertises a price
  placement would reject.

`graphics_banner BOOLEAN` (migration 0089) marks a rule whose promo
banner gets an AI-generated graphic. Only the FLAG lives here — the
image bytes and the generation queue live in
`zillaboost_banner_image_jobs`, because the pricing paths
(`loadBoostRulesForMatch` / `loadBoostRulesForMatches`) full-row-select
this table on hot catalog requests and must not drag a BYTEA along.

**`zillaboost_banner_image_jobs`** — pull queue + storage for AI banner
graphics (migration 0089). One row per rule (`rule_id` PK, FK
`boosted_odds_config` ON DELETE CASCADE): re-generating resets the SAME
row to `pending`, and the previous `image_data` stays in place until the
replacement lands, so the storefront banner never blanks mid-regenerate.
Drained by the operator-PC worker (`services/zillaboost-banner-gen`)
through `/webhooks/banner-gen/:secret/*` — the production box never
dials the operator's LAN, so a powered-off PC simply leaves rows at
`pending` until the worker returns and drains the backlog.

Columns of note:
- `status` — `pending` / `done` / `failed` (CHECK-constrained).
  "Processing" is not a status: a claimed job is a pending row with a
  live `leased_until`.
- `leased_until` — 15-minute claim lease stamped by `/pending`; a
  crashed worker's job self-returns when it expires. `/complete`
  requires the caller to still be inside its lease.
- `next_attempt_at` — generation-failure backoff (1 h per failed
  attempt). Partial index `(next_attempt_at) WHERE status='pending'`
  makes the claim query a tiny scan.
- `attempts` / `last_error` — real generation failures only; the worker
  doesn't claim (and burns nothing) while its local image backend is
  down. At 24 attempts the row flips to `failed` — surfaced as a red
  chip in the admin rules overview; unticking + re-ticking the graphics
  option resets it.
- `image_data BYTEA` + `image_mime` (paired CHECK, png/jpeg/webp
  allowlist) + `generated_at` — the finished graphic, served by
  `GET /catalog/zillaboost-banners/:ruleId/image` with an immutable
  cache header; `generated_at` rides the URL as `?v=` so a regenerated
  image is a new URL.
- `last_prompt text` (migration 0090) + `last_render_meta jsonb`
  (migration 0091) — the diffusion prompt this image was rendered from
  and the params behind it (checkpoint, latent class, cfg, steps,
  sampler, size, **seed**, negative prompt). Image quality is iterated
  by changing prompts, and before these the prompt existed only in the
  operator PC's worker log — so a bad-looking banner was undiagnosable
  from the backoffice. The seed is the reproducibility handle: prompt +
  seed + params lets an operator repeat the exact render by hand in
  ComfyUI. Both are nullable and optional in the upload route so an
  older worker build still completes jobs, and `/fail` records them too
  (COALESCEd, so a failure report never erases what a previous attempt
  stored). Surfaced in the admin overview by expanding the `img` chip.

The image bytes are a **DB blob on purpose**. Cardinality is bounded by
rule count (`rule_id` is the PK — one image per rule), each is ≤ 4 MiB,
the blob lives on the QUEUE table rather than `boosted_odds_config` so
the hot pricing selects never drag it along, and the byte-serve is
immutable-cached with a `?v=` stamp so Postgres is read roughly once per
browser. Object storage would add a credential and a failure mode for
nothing at this scale.

### Tickets

**`tickets`** — one per bet submission. `idempotency_key` is a unique
constraint that lets the client retry POST /bets safely. `stake_micro`,
`potential_payout_micro`, and `currency` are fixed at placement.
`actual_payout_micro` is written at settlement; NULL until then. Settlement
uses `currency` to find the right `(user_id, currency)` wallet row when
crediting payouts, refunds, and rollback adjustments. `quote_to_place_ms`
(migration 0097) is the gap between the placement intent token being
issued (`POST /bets/intent`) and `POST /bets` landing — NULL for rows
placed before the migration or while `intent_required` is off. Humans
spread widely; automation clusters just above the configured minimum, so
the RiskZilla behaviour rollup reads it as a confirm-time signal.

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
unresolved selections for a market. `boost_rule_id` (migration 0085, FK
`boosted_odds_config` ON DELETE SET NULL) records the Custom Boosted Odds
rule that priced the leg — of any scope, including a selection rule from
0087-0088 — the bet-delay worker skips the per-leg drift
tripwire for stamped legs because `odds_at_placement` is deliberately
above the raw published price; settlement is unaffected (payout reads
`odds_at_placement` regardless).

### Settlement

**`settlements`** — apply-once log for incoming Oddin settlement messages.
Unique key
`(event_urn, market_id, specifiers_hash, type, payload_hash)`
where `payload_hash` is sha256 of the canonicalized XML. An `ON CONFLICT DO
NOTHING` with `RETURNING id` tells the worker whether it actually inserted
(do work) or it's a replay (skip). `payload_json` is audit-only —
write-only in code. Retention: the nightly `oddzilla-settlements-retention`
cron deletes `settle`/`cancel` rows after 45 days (rollback rows are kept
forever; markets with open tickets are skipped; bettor-facing ticket
history in `tickets` / `wallet_ledger` / `market_outcomes.result` is
never deleted by anything). Deleting old dedup rows is safe because identical-payload replays
only arrive via AMQP redelivery or the 24 h-clamped recovery window — see
docs/OPERATIONS.md → "settlements retention" for the full argument.

Two `settlements` rows carry provenance beyond Oddin's own messages
(2026-09-06): the ladder inference in `services/settlement`
(`settler.ReconcileLadderLines`) writes `payload_json.extended_specifiers =
"inferred_from=threshold=25.5"` naming the settled sibling that decided the
line, and an operator void from `/admin/unsettled` arrives over
`settlement.external` as a `cancel` with `provider=admin` and is
audit-logged (`settlement.market_void`, `settlement.match_void_open`).

**`fonbet_market_denylist`**
(migration `20260906T103343_settlement_operator_tools`) — the Fonbet
catalogue tables and sub-event label prefixes the ingester must NOT turn
into markets because no grader can settle them from the results feed.
`kind` is `table` (with `provider_market_id`, the full 1 000 000 + table
number) or `label_prefix` (case-insensitive prefix of the sub-event
label, e.g. `Player specials`); a CHECK pins each kind to its own column
and two partial unique indexes stop duplicates. Seeded with 1007800
(winner of point N in a set), 1004500 / 1004551 (winner of game N in a
set), `Player specials` and `Special bets` — 36% of the Fonbet markets
still open after their match had closed on 2026-09-05 were these shapes.
fonbet-ingester re-reads the table every minute and applies it in the
mapper; markets already created under a rule are deactivated by the
ingest diff (status 0) and stay open — never voided — listed on
`/admin/unsettled/denylist`. Admin-managed, audit-logged.

**`fonbet_settlement_misses`**
(migration `20260906T103343_settlement_operator_tools`) — one row per
pending Fonbet match the results grader could not find in the results
feed, keyed by `match_id`, carrying the fixture as we hold it,
`segment_id`, how many markets are still open, and `candidates` — up to
20 `{name, startTime, score, status}` rows the results document listed
for the same competition on those line days, so the spelling or ordering
the two feeds disagree on is visible. Upserted on every grader pass the
match stays missing (`attempts`, `last_seen_at`), deleted the pass it is
found. Read by `GET /admin/unsettled/misses` (the Unmatched results tab).
Before this the grader logged only `no_result: 797` and nothing said
which fixture.

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

`prev_hash BYTEA` and `row_hash BYTEA` (PR #130) form a SHA-256 hash
chain across the table. The BEFORE INSERT trigger
`admin_audit_log_chain_trg` reads the previous row's `row_hash`,
computes `digest(prev_hash || canonical_payload, 'sha256')`, and
populates both columns on the new row. A transaction-scoped advisory
lock (`pg_advisory_xact_lock(hashtext('admin_audit_log_chain'))`)
serialises concurrent inserts so the chain is deterministic. Existing
rows were backfilled by migration 0026 so the chain is valid from
row 1.

The verifier function `admin_audit_chain_check()` returns `(id, ok)`
per row by recomputing the expected hashes in id order; any `ok=false`
row has been tampered with after insert (or the chain has a structural
break at that id). Run it from oncall:

```sql
SELECT COUNT(*) FILTER (WHERE ok) AS valid,
       COUNT(*) FILTER (WHERE NOT ok) AS broken,
       COUNT(*) AS total
  FROM admin_audit_chain_check();
```

`broken=0` always. Non-zero is the canonical "someone modified the
audit table via direct DB access" signal.

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

### FE analytics (first-party)

Migration 0083. Self-hosted storefront behaviour capture — the tracker in
`apps/web/src/lib/analytics/` batches to `POST /analytics/collect`; no
third-party analytics vendor sees bettor traffic. Retention runs as an
hourly sweep in the api service (Redis NX lock): 90 days for sessions +
events, 14 days for mouse batches.

**`analytics_sessions`** — one row per browser session. The PK is a
client-generated UUID (per-tab `sessionStorage`, renewed after 30 min
idle) so a session spans SSR navigations without a server round-trip at
start. `user_id` is NULL for anonymous visitors and set by the first
authed flush (`COALESCE` on conflict — a session never switches owner).
Denormalised `page_view_count` / `click_count` / `event_count` are bumped
by the number of event rows that actually inserted, so KPI and list
queries never aggregate the events table per session.
`behaviour_score` / `behaviour_features` / `behaviour_scored_at`
(migration 0098) are written by the RiskZilla behaviour sweeper once a
signed-in session has been quiet for two minutes: the automation
likelihood in [0, 1], the per-component measurements as JSON, and when
it was scored. NULL score with a non-NULL scored_at means "too little
data to say" (touch devices, brief visits) — deliberately not a guess.
The partial index `analytics_sessions_behaviour_pending_idx` is the
sweeper's work queue (signed-in sessions never scored or seen again since).

**`analytics_events`** — append-only journey log (`page_view`, `click`,
`heartbeat`, `session_end`). The client stamps a per-session monotonic
`seq`, giving exact click order and apply-once ingestion via
`UNIQUE (session_id, seq)` — pagehide flushes can double-deliver
(sendBeacon + keepalive), and replays are row-level no-ops. `kind` and
`section` are open TEXT on purpose: new event kinds / storefront
sections must not need a migration (same rationale as
`zillapass_tasks.predicate_key`); the API validates with zod. `payload`
carries the click target descriptor (`label` precomputed client-side so
the admin "top clicked elements" view is a plain `GROUP BY
payload->>'label'`).

**`analytics_mouse_batches`** — sampled mouse trails: one point per
120 ms while the pointer moves, stored as `[[dtMs, x, y], ...]` JSONB
per flush segment with viewport dims for replay scaling. Shares the
per-session `seq` counter space with events. By far the heaviest table,
hence the shorter 14-day retention and its own `created_at` sweep index.

### ComboZilla (lobby prebuilt 3-fold carousel)

Migration `20260906T015446_combozilla_config` (2026-09-06). ComboZilla picks
four 3-fold parlays (Safe / Challenging / Risky / Ultimate) out of the
prematch offer for the home page. Until this migration the whole selection
policy lived as constants in `apps/web/src/lib/three-fold-builder.ts` —
risk tiers 1..3 only, and only cs2 / dota2 / lol allowed more than one card
— which, after ZillaAGI's standing +1 margin put most of the traditional
line at T4-T6, meant the Fonbet offer never reached the carousel at all.

**`combozilla_config`** — singleton (`id = 'default'`, CHECK-enforced).
`enabled`; `eligible_risk_tiers smallint[]` (CHECK `<@ 1..10`; empty =
nothing qualifies by tier alone); `allow_untiered` (a NULL tier is priced by
RiskZilla at the STRICTEST tier, so it is out by default); `multi_card_
sport_slugs text[]` (slugs, like `users.hidden_sports` — every other sport is
capped at one card per render). Column defaults reproduce the old constants
exactly, so an estate that never opens the page renders what it always did.
Written only by `PUT /admin/combozilla-config`, audit-logged.

**`combozilla_scope_rules`** — operator overrides. `scope` in `sport` /
`category` / `tournament` and `mode` in `allow` / `block` are CHECK'd TEXT
rather than enums (a fourth scope is one ALTER, not the two-file add-value
dance). One typed FK per scope tier with `ON DELETE CASCADE`, a
scope-consistency CHECK pinning exactly one populated ref, and a partial
unique index per scope so the lookup is "at most one row per (scope, ref)" —
the `riskzilla_live_delay_config` shape. Resolution is most specific wins:
tournament > category > sport > tier default. **`allow` is unconditional**:
it admits the scope regardless of tier, because anything already eligible
needs no rule and that is the only meaning "manually add" can have.

The policy is resolved in ONE place, `services/api/src/lib/combozilla.ts`,
as a SQL CASE over the `matches → tournaments → categories → sports` join,
and consumed by both `GET /catalog/combozilla-pool` (the storefront's
candidate set, capped per sport) and the backoffice preview. No index on
either table — a handful of rows, read through the CASE as bound `IN`
lists.

### RiskZilla bot controls + behaviour scoring

Migrations 0096–0098 (2026-09-03). Bet placement cannot be restricted to
a physical mouse click — the server only sees HTTP — so these tables back
the controls that make automation gain nothing and get noticed. None of
them sit on the placement hot path beyond one memoised singleton read.

**`riskzilla_bot_controls`** — singleton (`id = 1`) operator knobs:
`intent_required` (POST /bets demands a placement intent token from
POST /bets/intent; the emergency off-switch), `intent_ttl_seconds`,
`min_human_ms` (quote → place floor; `intent_too_fast` below it),
`velocity_enabled` + `max_bets_per_minute` / `max_matches_per_minute`
(base caps at risk score 1.000; effective cap = `max(1, round(base × RS))`),
`behaviour_alert_threshold` + `behaviour_min_sessions` (when the rollup
below raises an alert). CHECK-bounded, audit-logged on every PUT. Lives in
Postgres rather than Redis for the same reason `feed_control` does.

**`riskzilla_decision`** gains `rejected_velocity` (0096, its own file
because a new enum value cannot be referenced in the transaction that
added it) so velocity rejections land in `riskzilla_event_log` next to
every other gate.

**`bettor_behaviour_scores`** — one row per bettor the sweeper has looked
at. `score` blends the sample-weighted mean of `analytics_sessions.
behaviour_score` over 30 days (80%) with the confirm-time signal from
`tickets.quote_to_place_ms` (20%, only with ≥ 10 tickets); `max_session_
score`, `sessions_scored`, `sessions_insufficient` and a `features` JSON
summary (per-component averages, reason counts, confirm-time stats) feed
the admin panel. `alert` follows the threshold with 0.1 of hysteresis;
`alert_since` keeps the original raise time while it holds, and a newly
raised alert clears `acknowledged_at` / `acknowledged_by` so a fresh spike
needs a fresh review. Partial index on `alert = TRUE` for the alerts
list, plain index on `score DESC NULLS LAST` for the bettors sort.

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
2. Write the equivalent SQL in
   `packages/db/migrations/<YYYYMMDDTHHMMSS>_<lower_snake_desc>.sql`. Get the
   prefix from `date -u +%Y%m%dT%H%M%S` — see "Why timestamps, not numbers"
   below.
3. `pnpm db:check-migrations` — also chained onto `packages/db`'s `lint`, so
   `pnpm lint` and CI both run it.
4. `make migrate` applies the new file(s) in a transaction per file and
   records success in the `_migrations` table.
5. Commit.

Do not hand-append to `packages/db/migrations/meta/_journal.json`. That step
used to be listed here, but the runner reads the directory rather than the
journal, and the file has been unmaintained since `0058` — 65 migrations have
landed without it. It stays in the tree only because drizzle-kit owns it.

### Why timestamps, not numbers

Migrations `0000`–`0110` use a four-digit sequence number. That number was a
shared counter allocated from a local snapshot: you read the directory, took
the highest, added one — except you read *your branch's* copy, which is main
as it stood when you branched. Two branches off the same commit both see the
same max and both claim it.

Nothing catches it. Git can't: the branches add *different files*, so there is
no textual overlap and the merge is clean. The migrate job can't either: it
applies everything to an empty database and passes, because colliding
migrations are usually unrelated — and with both PRs open at once, neither run
sees the other's file. The collision exists only in the merged tree, the one
state nobody built. It happened **11 times**, `0045` three ways.

It is not cosmetic. `migrate.ts` sorts by filename, so a tie is broken by the
description text — `0110_drop_live_chat` runs before `0110_logo_source_wikipedia`
because `d` < `l`, which is luck rather than intent. And production applies each
migration when its PR deploys (merge order) while a fresh dev or CI database
applies them all in one pass (alphabetical order); when those disagree, the same
repo produces two different schemas and nothing errors.

A UTC timestamp comes from a clock instead of from reading a directory, so two
authors cannot collide. The numeric era is frozen at `0110`; every `0NNN_` name
sorts before every `2026…` name, so the two eras concatenate and nothing needed
renaming. [`packages/db/src/check-migrations.ts`](../packages/db/src/check-migrations.ts)
enforces the form, the freeze, and prefix uniqueness.

**If one still slips through**, it will be because two PRs were open at once —
neither one's CI sees the other's file, and the one that merges second is not
re-checked against the new base. The usual cure, "require branches to be up to
date before merging" or a merge queue, is not available on this repo: classic
branch protection and rulesets both need GitHub Pro on a private repo, and this
is a free personal plan (the API answers 403, verified 2026-09-06).

What covers it instead is that the check is chained onto `packages/db`'s `lint`
script, so it runs inside the `pnpm lint` that CI performs on pull requests **and
on every push to `main`** — the check goes red on main within about a minute of
the merge. That is early enough to matter:
renaming a migration is only dangerous once it has been **applied**, and applying
happens on a manual `make deploy`, never automatically. Red main means rename it
before the next deploy, and it costs nothing.

**Never rename or edit an applied migration.** `_migrations` keys on the
filename with no checksum, so a rename makes the runner treat it as new and run
it again; an edit is applied to fresh databases but not to production. Fix a bad
name while the PR is still open — that is the only window in which it is free.

We don't use `drizzle-kit migrate` — our migrations include Postgres features
(partitioning, extensions) Drizzle can't emit. Drizzle owns the TS schema for
typed queries; SQL files are the runtime source of truth.
